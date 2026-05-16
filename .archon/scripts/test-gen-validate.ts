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
 * Expected (two shapes):
 *
 *   A. TS2307 "Cannot find module 'X'" where X resolves to a
 *      contract-promised path. This is the *direct-import* shape:
 *      a test does `import { x } from "../../convex/admin/templates"`
 *      and that file does not exist yet at red state.
 *
 *   B. TS2339 "Property 'P' does not exist on type ..." where P is a
 *      directory/file segment directly under a Convex `convex/` root
 *      that the contract promises to create. This is the *Convex
 *      api-object* shape: Convex tests never import functions
 *      directly — they access them as properties on the single
 *      generated `api` object (`api.admin.templates.listAll`). At red
 *      state the regenerated `api` has no `admin` namespace yet
 *      (because `convex/admin/` doesn't exist), so tsc emits TS2339
 *      on the FIRST missing segment (`admin`). A correct Convex
 *      red-state test referencing contract-promised-but-not-yet-built
 *      functions produces TS2339, never TS2307 — the classifier must
 *      model both or it wrongly rejects correct tests (see WOR-132
 *      run journal entry).
 *
 * Everything else is unexpected.
 */
function isExpectedRedStateError(err: TscError, contractPaths: string[]): boolean {
  return (
    isExpectedRedStateImport(err, contractPaths) ||
    isExpectedRedStateConvexApiProperty(err, contractPaths)
  );
}

/**
 * Shape A — TS2307 cannot-find-module against a contract-promised path.
 *
 * Two flavors of import to handle:
 *
 *   1. Multi-segment relative imports like `../../convex/schema` from
 *      `tests/unit/foo.test.ts`. After stripping leading `..` segments,
 *      the import becomes `convex/schema` which matches the contract
 *      path `convex/schema.ts` by suffix (or equality after stripping
 *      file extensions).
 *
 *   2. Same-directory relative imports like `./fixtures` from
 *      `e2e/smoke.spec.ts`. After stripping `./`, the import is just
 *      `fixtures` — shorter than the contract path `e2e/fixtures.ts`.
 *      We need a basename match for these: `./fixtures` can only refer
 *      to a sibling of the importing file, so if any contract path's
 *      basename equals the single-segment import, accept.
 */
function isExpectedRedStateImport(err: TscError, contractPaths: string[]): boolean {
  if (err.code !== 'TS2307') return false;
  const moduleMatch = err.message.match(/Cannot find module ['"]([^'"]+)['"]/);
  if (!moduleMatch) return false;
  const importPath = moduleMatch[1];

  // Normalize: strip leading `./` and `../` segments, trailing TS extension.
  // `./fixtures` → `fixtures`. `../../convex/schema` → `convex/schema`.
  const cleanImport = importPath
    .replace(/^(\.\.?\/)+/g, '')
    .replace(/\.(ts|tsx|js|jsx|mts|cts)$/, '');

  // Basename of the import — the leaf, e.g. `fixtures` from `convex/lib/fixtures`.
  const importBasename = cleanImport.includes('/')
    ? cleanImport.slice(cleanImport.lastIndexOf('/') + 1)
    : cleanImport;

  for (const cp of contractPaths) {
    const cleanCp = cp.replace(/^\.\//, '').replace(/\.(ts|tsx|js|jsx|mts|cts)$/, '');
    const cpBasename = cleanCp.includes('/')
      ? cleanCp.slice(cleanCp.lastIndexOf('/') + 1)
      : cleanCp;

    // Direct equality of normalized paths.
    if (cleanImport === cleanCp) return true;
    // Import path is a suffix of the contract path. Covers the common
    // case: `../../convex/schema` → `convex/schema` matches the contract's
    // `convex/schema.ts` because the contract path ends with the import.
    if (cleanCp.endsWith('/' + cleanImport)) return true;
    // Contract path is a suffix of the import (symmetric, rarer).
    if (cleanImport.endsWith('/' + cleanCp)) return true;
    // Single-segment import (`./fixtures` → `fixtures`) matches a
    // contract path's basename — `e2e/fixtures.ts` has basename
    // `fixtures`. Constrained to single-segment imports so we don't
    // false-positive on e.g. `helpers` against an unrelated
    // `some/other/helpers.ts`.
    if (!cleanImport.includes('/') && importBasename === cpBasename) return true;
  }
  return false;
}

/**
 * Shape B — TS2339 "Property 'P' does not exist on type ..." where P is
 * a segment directly under a Convex `convex/` root that the contract
 * promises to create.
 *
 * Convex generates a single `api` object whose shape mirrors the
 * `convex/` directory tree: `convex/admin/templates.ts` exporting
 * `listAll` is reached as `api.admin.templates.listAll`. At red state
 * the contract-promised module doesn't exist, so the regenerated `api`
 * lacks the namespace and tsc reports TS2339 on the FIRST missing
 * segment — e.g. `Property 'admin' does not exist on type '{ users:
 * ... }'` for a reference to `api.admin.templates.listAll`.
 *
 * Tightness: we accept ONLY when the missing property name equals the
 * first path segment beneath a `convex/` contract path (the namespace
 * root the contract is about to create). A genuine property typo on an
 * EXISTING namespace (e.g. `api.users.mee`) produces TS2339 with
 * property `mee`, which is not a `convex/`-level contract segment, so
 * it stays correctly classified as unexpected. We do not try to walk
 * deeper property chains — the first missing segment is sufficient and
 * keeps the rule conservative.
 */
function isExpectedRedStateConvexApiProperty(
  err: TscError,
  contractPaths: string[],
): boolean {
  if (err.code !== 'TS2339') return false;
  const propMatch = err.message.match(
    /Property ['"]([^'"]+)['"] does not exist on type/,
  );
  if (!propMatch) return false;
  const missingProp = propMatch[1];

  // First path segment beneath a `convex/` contract path. For
  // `convex/admin/templates.ts` → `admin`; for `convex/schema.ts` →
  // `schema`. Only Convex-rooted contract paths participate — this
  // shape is Convex-`api`-object specific.
  for (const cp of contractPaths) {
    const clean = cp.replace(/^\.\//, '');
    const m = clean.match(/^convex\/([^/]+?)(?:\/|\.[a-z]+$|$)/);
    if (m && m[1] === missingProp) return true;
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

// File-scoped causal red-state rule (WOR-132 journal entry):
//
// A correct Convex test that references a contract-promised-but-not-
// yet-built namespace (`api.admin.templates.create`) produces ONE
// TS2339 on the missing namespace root (`admin`) PLUS a cascade of
// further TS2339s — every `result.globalGuidance` etc. fails because
// the absent `api.admin` collapses the inferred return type to a
// fallback (the `users` doc type bleeding everywhere). Those cascade
// errors are causally downstream of the single missing namespace, not
// independent defects.
//
// So: a test file is "in red state for a contracted namespace" if it
// has at least one *anchor* error proving a contract module is absent
// — either a TS2307 cannot-find-module on a contract path, or a
// TS2339 on a `convex/` contract namespace root. In such a file ALL
// of its TS2339s are treated as expected (the cascade). Files with no
// anchor keep the strict per-error classification, so genuine field
// typos in green-state tests are still caught.
const redStateFiles = new Set<string>();
for (const err of tscErrors) {
  if (
    isExpectedRedStateImport(err, contractPaths) ||
    isExpectedRedStateConvexApiProperty(err, contractPaths)
  ) {
    redStateFiles.add(err.file);
  }
}

const expected: TscError[] = [];
const unexpected: TscError[] = [];
for (const err of tscErrors) {
  if (isExpectedRedStateError(err, contractPaths)) {
    expected.push(err);
  } else if (err.code === 'TS2339' && redStateFiles.has(err.file)) {
    // Cascade error in a file with a proven-absent contract namespace.
    expected.push(err);
  } else {
    unexpected.push(err);
  }
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
