#!/usr/bin/env bun
/**
 * Validate the test-gen output beyond a binary "tsc passes" check.
 *
 * Goals (matching ARCHIE_COMMENT_FORMAT.md / task-tests intent):
 *
 *   1. NO TypeScript escape hatches in any test file.
 *      `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`, explicit `any`,
 *      `as any`, `as unknown` are forbidden — they hide real bugs in
 *      test code under the guise of "red-state suppression". The
 *      validator below catches them mechanically.
 *
 *   2. RUN tsc, but distinguish EXPECTED red-state errors from UNEXPECTED
 *      test-code defects:
 *      - Expected: `TS2307 Cannot find module 'X'` where X resolves to a
 *        contract-promised file (i.e. the contract says "this file will
 *        be created by task-implement"). At red state these files don't
 *        exist yet, so the import error is the point.
 *      - Unexpected: everything else. Real defects. Hard fail.
 *
 *   3. LINT pass is still required (no escape from ESLint either).
 *
 * Reads:
 *   $ARTIFACTS_DIR/contract.md   — for the list of files
 *                                   that task-implement will create
 *   package.json                  — for the `typecheck` / `lint` scripts
 *   tests/**\/*.ts                  — to scan for escape hatches
 *
 * Writes (stdout, single-line JSON for the workflow runtime):
 *   {
 *     "passed": true | false,
 *     "lint": "passed" | "failed" | "missing",
 *     "typecheck": "passed" | "failed" | "missing",
 *     "escape_hatches_found": N,
 *     "unexpected_typecheck_errors": N,
 *     "expected_typecheck_errors": N,
 *     "report": "<path to detailed report>"
 *   }
 *
 * Writes (artifact files):
 *   $ARTIFACTS_DIR/test-gen-validate-report.json — structured detail
 *   $ARTIFACTS_DIR/test-gen-lint.log              — raw lint output
 *   $ARTIFACTS_DIR/test-gen-typecheck.log         — raw tsc output
 *
 * Exit code 0 always — the workflow runtime keys off the JSON `passed`
 * field, not the process exit status. A non-zero exit would cause the
 * DAG to mark the node as failed instead of recording the structured
 * verdict for downstream nodes (repair-generated-tests).
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  process.stderr.write('ARTIFACTS_DIR not set\n');
  process.exit(1);
}

const cwd = process.cwd();
const reportPath = `${artifactsDir}/test-gen-validate-report.json`;
const lintLog = `${artifactsDir}/test-gen-lint.log`;
const typecheckLog = `${artifactsDir}/test-gen-typecheck.log`;

// ─── Escape-hatch scan ─────────────────────────────────────────────────

/**
 * Patterns that mean "TypeScript is turned off here." Each match in a
 * test file is a hard fail. Patterns intentionally err on the side of
 * false positives — test authors should not be writing these at all.
 */
const ESCAPE_HATCH_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: '@ts-expect-error', regex: /@ts-expect-error\b/ },
  { name: '@ts-ignore', regex: /@ts-ignore\b/ },
  { name: '@ts-nocheck', regex: /@ts-nocheck\b/ },
  // Explicit `: any` type annotations. We accept `Record<string, any>`-style
  // legitimate uses by requiring a word boundary on both sides — the regex
  // matches things like `x: any`, `(): any`, `as any` but skips `MyAny` /
  // `any[]` (which is also bad, separately matched below).
  { name: 'explicit any annotation', regex: /:\s*any\b(?!\w)/ },
  { name: 'as any cast', regex: /\bas\s+any\b/ },
  { name: 'as unknown cast', regex: /\bas\s+unknown\b/ },
  // any[] arrays — same disease, different shape.
  { name: 'any[] array type', regex: /:\s*any\[\]/ },
];

interface EscapeHatchHit {
  file: string;
  line: number;
  column: number;
  pattern: string;
  text: string;
}

async function findTestFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      // Skip node_modules / hidden dirs / build output
      if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist') continue;
      await findTestFiles(full, out);
    } else if (e.isFile() && /\.(test|spec)\.(ts|tsx|mts|cts)$/.test(e.name)) {
      out.push(full);
    }
  }
}

async function scanEscapeHatches(): Promise<EscapeHatchHit[]> {
  // Scan everything under tests/ AND any *.test.ts file at the repo root.
  // Most projects keep tests under tests/ or src/__tests__; we cast a
  // wide net rather than guess.
  const candidates: string[] = [];
  if (existsSync(join(cwd, 'tests'))) await findTestFiles(join(cwd, 'tests'), candidates);
  if (existsSync(join(cwd, 'src'))) await findTestFiles(join(cwd, 'src'), candidates);
  if (existsSync(join(cwd, 'e2e'))) await findTestFiles(join(cwd, 'e2e'), candidates);

  const hits: EscapeHatchHit[] = [];
  for (const file of candidates) {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pat of ESCAPE_HATCH_PATTERNS) {
        const m = line.match(pat.regex);
        if (m) {
          hits.push({
            file: relative(cwd, file),
            line: i + 1,
            column: (m.index ?? 0) + 1,
            pattern: pat.name,
            text: line.trim(),
          });
        }
      }
    }
  }
  return hits;
}

// ─── Contract parsing ──────────────────────────────────────────────────

/**
 * Read the contract's `files[]` list to discover which paths
 * task-implement will create. A tsc error referencing one of those
 * paths at red state is expected and tolerated.
 */
async function readContractPaths(): Promise<string[]> {
  // The contract lives under $ARTIFACTS_DIR/contract.md (the canonical
  // location written by create-contract). Don't fall through to
  // docs/contracts/ — that's the worktree copy and may not exist yet at
  // validation time.
  const path = `${artifactsDir}/contract.md`;
  if (!existsSync(path)) return [];
  const content = await readFile(path, 'utf8');

  const paths: string[] = [];
  // Match YAML front-matter `files:` block — each entry is `- path: X`.
  const filesRe = /^\s*-\s*path:\s*(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = filesRe.exec(content)) !== null) {
    paths.push(m[1].trim().replace(/^["']|["']$/g, ''));
  }
  return paths;
}

// ─── Typecheck parsing ─────────────────────────────────────────────────

interface TscError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

/**
 * Parse `tsc --noEmit --pretty false` output. Each error is a line
 * matching `path(line,col): error TSnnnn: message`. Multi-line message
 * continuations (indented) are appended to the previous error.
 */
function parseTscOutput(stdout: string): TscError[] {
  const errors: TscError[] = [];
  const lines = stdout.split('\n');
  const re = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/;
  let current: TscError | null = null;
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      if (current) errors.push(current);
      current = {
        file: m[1],
        line: parseInt(m[2], 10),
        column: parseInt(m[3], 10),
        code: m[4],
        message: m[5],
      };
    } else if (current && line.startsWith('  ')) {
      // Continuation
      current.message += ' ' + line.trim();
    }
  }
  if (current) errors.push(current);
  return errors;
}

/**
 * Classify a tsc error as expected (red-state, ok) or unexpected
 * (real defect, hard fail).
 *
 * Expected:
 *   - TS2307 "Cannot find module 'X'" where X resolves to a
 *     contract-promised path.
 *
 * Everything else is unexpected.
 */
function isExpectedRedStateError(err: TscError, contractPaths: string[]): boolean {
  if (err.code !== 'TS2307') return false;
  // Message looks like: `Cannot find module '../../convex/schema' or its corresponding type declarations.`
  const moduleMatch = err.message.match(/Cannot find module ['"]([^'"]+)['"]/);
  if (!moduleMatch) return false;
  const importPath = moduleMatch[1];
  // Strip leading `./` and `../` to get just the trailing path component
  // that's likely to match the contract entry. e.g. `../../convex/schema`
  // → `convex/schema`. We accept either the bare resolution OR the full
  // relative import as long as the suffix matches a contract path.
  for (const cp of contractPaths) {
    // Normalize: contract paths may or may not have a leading `./`.
    const cleanCp = cp.replace(/^\.\//, '').replace(/\.(ts|tsx|js|jsx|mts|cts)$/, '');
    const cleanImport = importPath.replace(/^\.+\//g, '').replace(/\.(ts|tsx|js|jsx|mts|cts)$/, '');
    if (cleanImport === cleanCp || cleanImport.endsWith('/' + cleanCp)) {
      return true;
    }
  }
  return false;
}

// ─── Lint / typecheck script runners ───────────────────────────────────

async function hasScript(name: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    return !!pkg.scripts?.[name];
  } catch {
    return false;
  }
}

async function runScript(name: string, logPath: string): Promise<{ status: 'passed' | 'failed' | 'missing'; stdout: string }> {
  if (!(await hasScript(name))) {
    await writeFile(logPath, `Missing package.json script: ${name}\n`);
    return { status: 'missing', stdout: '' };
  }
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['run', name], {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
    });
    const combined = stdout + stderr;
    await writeFile(logPath, combined);
    return { status: 'passed', stdout: combined };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const combined = (err.stdout ?? '') + (err.stderr ?? '') + (err.message ?? '');
    await writeFile(logPath, combined);
    return { status: 'failed', stdout: combined };
  }
}

// ─── Main ──────────────────────────────────────────────────────────────

const hatches = await scanEscapeHatches();
const contractPaths = await readContractPaths();

if (!existsSync(join(cwd, 'package.json'))) {
  const out = {
    passed: false,
    lint: 'failed' as const,
    typecheck: 'failed' as const,
    escape_hatches_found: hatches.length,
    unexpected_typecheck_errors: 0,
    expected_typecheck_errors: 0,
    reason: 'missing_package_json',
    report: reportPath,
  };
  await writeFile(reportPath, JSON.stringify(out, null, 2));
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

const lintResult = await runScript('lint', lintLog);
const typecheckResult = await runScript('typecheck', typecheckLog);

// Parse tsc output for classification — even if typecheck "passed",
// there may still be informational output. We only care about errors.
const tscErrors = parseTscOutput(typecheckResult.stdout);
const expected: TscError[] = [];
const unexpected: TscError[] = [];
for (const err of tscErrors) {
  if (isExpectedRedStateError(err, contractPaths)) expected.push(err);
  else unexpected.push(err);
}

// A test-gen typecheck "passes" iff:
//   1. No escape hatches in any test file.
//   2. No unexpected typecheck errors. (Expected red-state errors are ok.)
//   3. Lint passes (or is missing — we don't require a lint script).
const typecheckOk = unexpected.length === 0;
const lintOk = lintResult.status !== 'failed';
const noHatches = hatches.length === 0;
const passed = typecheckOk && lintOk && noHatches;

const detail = {
  passed,
  lint: lintResult.status,
  typecheck: typecheckOk ? 'passed' : 'failed',
  escape_hatches_found: hatches.length,
  escape_hatches: hatches,
  unexpected_typecheck_errors: unexpected.length,
  unexpected_errors: unexpected,
  expected_typecheck_errors: expected.length,
  expected_errors: expected,
  contract_paths: contractPaths,
  lint_log: lintLog,
  typecheck_log: typecheckLog,
  report: reportPath,
};
await writeFile(reportPath, JSON.stringify(detail, null, 2));

// Summary on stdout for the workflow runtime to read.
process.stdout.write(JSON.stringify({
  passed: detail.passed,
  lint: detail.lint,
  typecheck: detail.typecheck,
  escape_hatches_found: detail.escape_hatches_found,
  unexpected_typecheck_errors: detail.unexpected_typecheck_errors,
  expected_typecheck_errors: detail.expected_typecheck_errors,
  report: detail.report,
}));
