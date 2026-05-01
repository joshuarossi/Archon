#!/usr/bin/env bun
/**
 * Remove obsolete @ts-expect-error directives from generated ticket tests.
 *
 * Test generation may need @ts-expect-error for red-state imports/types that do
 * not exist yet. Once implementation lands, TypeScript reports unused
 * directives as TS2578. The dev agent is intentionally forbidden from editing
 * tests, so validation owns this narrow deterministic cleanup.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface TriggerPayload {
  issue_key: string;
}

interface TypecheckResult {
  ok: boolean;
  output: string;
}

interface DirectiveHit {
  relPath: string;
  line: number;
}

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  throw new Error('ARTIFACTS_DIR not set');
}

const reportPath = `${artifactsDir}/obsolete-ts-expect-error-cleanup.json`;
const trigger = JSON.parse(
  readFileSync(`${artifactsDir}/trigger-payload.json`, 'utf8'),
) as TriggerPayload;
const issueKey = trigger.issue_key;
const issueLc = issueKey.toLowerCase();
const repoRoot = (await git('rev-parse', '--show-toplevel')).trim();

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: process.cwd(),
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

function hasTypecheckScript(): boolean {
  if (!existsSync('package.json')) return false;
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return typeof pkg.scripts?.typecheck === 'string';
}

async function runTypecheck(): Promise<TypecheckResult> {
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['run', 'typecheck'], {
      cwd: process.cwd(),
      maxBuffer: 50 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}\n${stderr}` };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}`,
    };
  }
}

function toRepoRelative(rawPath: string): string {
  const normalized = rawPath.trim().replace(/\\/g, '/');
  const absolute = resolve(normalized);
  if (absolute === repoRoot || absolute.startsWith(`${repoRoot}/`)) {
    return relative(repoRoot, absolute).replace(/\\/g, '/');
  }
  return normalized.replace(/^\.\//, '');
}

function isTicketTestFile(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return lower.startsWith(`tests/${issueLc}/`) || lower.startsWith(`e2e/${issueLc}/`);
}

function parseUnusedExpectErrorHits(output: string): DirectiveHit[] {
  const hits = new Map<string, DirectiveHit>();
  const diagnosticPattern =
    /([^\s:(]+\.(?:tsx?|jsx?|mjs|cjs))\((\d+),(\d+)\):\s*error\s+TS2578:\s*Unused\s+'@ts-expect-error'\s+directive\./g;

  for (const match of output.matchAll(diagnosticPattern)) {
    const relPath = toRepoRelative(match[1] ?? '');
    const line = Number(match[2]);
    if (!Number.isInteger(line) || line < 1) continue;
    if (!isTicketTestFile(relPath)) continue;
    hits.set(`${relPath}:${line}`, { relPath, line });
  }

  return Array.from(hits.values());
}

function removeDirectiveLines(hits: DirectiveHit[]): string[] {
  const byFile = new Map<string, Set<number>>();
  for (const hit of hits) {
    const lines = byFile.get(hit.relPath) ?? new Set<number>();
    lines.add(hit.line);
    byFile.set(hit.relPath, lines);
  }

  const changedFiles: string[] = [];
  for (const [relPath, linesToRemove] of byFile) {
    if (!existsSync(relPath)) continue;
    const before = readFileSync(relPath, 'utf8');
    const hadTrailingNewline = before.endsWith('\n');
    const lines = before.split(/\r?\n/);
    const next = lines.filter((line, index) => {
      const oneBasedLine = index + 1;
      return !(linesToRemove.has(oneBasedLine) && line.includes('@ts-expect-error'));
    });
    const after = next.join('\n').replace(/\n*$/, hadTrailingNewline ? '\n' : '');
    if (after !== before) {
      writeFileSync(relPath, after);
      changedFiles.push(relPath);
    }
  }

  return changedFiles;
}

async function commitCleanup(changedFiles: string[]): Promise<string | null> {
  if (changedFiles.length === 0) return null;

  await git('add', '--', ...changedFiles);
  try {
    await execFileAsync('git', ['diff', '--cached', '--quiet', '--', ...changedFiles], {
      cwd: process.cwd(),
    });
    return null;
  } catch {
    // git diff --quiet exits non-zero when a diff exists.
  }

  await git('commit', '-m', `[test-cleanup] ${issueKey}: remove obsolete ts-expect-error`, '--', ...changedFiles);
  return (await git('rev-parse', 'HEAD')).trim();
}

if (!hasTypecheckScript()) {
  const report = { changed: false, skipped: true, reason: 'missing typecheck script', files: [] };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exit(0);
}

const allChanged = new Set<string>();
let finalHits: DirectiveHit[] = [];

for (let pass = 1; pass <= 5; pass += 1) {
  const result = await runTypecheck();
  const hits = parseUnusedExpectErrorHits(result.output);
  finalHits = hits;
  if (hits.length === 0) break;

  const changed = removeDirectiveLines(hits);
  for (const file of changed) allChanged.add(file);

  if (changed.length === 0) {
    break;
  }
}

const files = Array.from(allChanged).sort();
const commit = await commitCleanup(files);
const report = {
  changed: files.length > 0,
  skipped: false,
  files,
  commit,
  remaining_unused_directives: finalHits.length,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
