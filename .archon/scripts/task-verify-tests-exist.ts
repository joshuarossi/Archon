#!/usr/bin/env bun
/**
 * Verify that the test-gen agent actually wrote at least one test file.
 *
 * Strategy: diff against main, find files matching test patterns. If the count
 * is zero, halt the workflow — agent produced nothing testable.
 *
 * Test-shaped paths:
 *   tests/**, test/**, e2e/**, __tests__/**
 *   *.test.{ts,tsx,js,jsx,mjs,cjs}
 *   *.spec.{ts,tsx,js,jsx,mjs,cjs}
 *   playwright.config.{ts,js}, vitest.config.{ts,js} (test infra files count too)
 *
 * Two output channels (per Archon's authoring-workflows contract):
 *
 *   INFORMATION channel — writes the full report to
 *     `$ARTIFACTS_DIR/test-files-report.json` for any downstream node
 *     that wants the file list (e.g. jira-transition-task-to-in-progress.ts
 *     reads this to enrich the Jira comment).
 *
 *   STATE channel — emits a small JSON object on stdout for `when:`
 *     condition evaluation via `$node.output.field`. Archon's bash-node
 *     runtime captures stdout as `nodeOutput.output` and parses it as
 *     JSON when conditional substitution requests a `.field`.
 *
 * Narration → stderr (irrelevant to the contract; just keeps stdout clean
 * for the state channel).
 */
import { readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

async function git(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: process.cwd(),
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const detail = (err.stderr || err.stdout || err.message || String(e)).trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

console.error('Diffing working tree against origin/main to find test files...');

// Refresh origin/main first so the diff compares against the actual current
// main, not whatever stale ref this worktree last fetched. Sibling tickets
// that landed on main while this worktree was idle would otherwise show up
// as "added by this PR" and inflate the test-file count, or — in the
// reverse case — newly-committed tests in this branch could appear
// unchanged because the local origin/main already contains them.
try {
  await git('fetch', 'origin', 'main', '--quiet');
} catch (e) {
  console.error(`Warning: could not refresh origin/main: ${(e as Error).message}`);
}

// Include both committed and uncommitted changes — depending on agent ordering
// the tests might be staged-but-not-committed when this runs.
// `git diff origin/main --name-only` covers committed changes;
// `git status --porcelain -uall` covers uncommitted ones. -uall expands
// untracked directories into their individual files; without it, an
// untracked `tests/wor-N/` directory shows as a single line with a trailing
// slash and never matches the test-file regex below.
const committedFiles = (await git('diff', 'origin/main', '--name-only')).split('\n').filter(Boolean);
const statusOut = (await git('status', '--porcelain', '-uall')).split('\n').filter(Boolean);
// status format: "XY filename" — strip the 2 status chars + space
const uncommittedFiles = statusOut.map(line => line.slice(3).trim()).filter(Boolean);

const allChanged = [...new Set([...committedFiles, ...uncommittedFiles])];

const TEST_PATH_PATTERNS = [
  /(^|\/)tests?\//,
  /(^|\/)e2e\//,
  /(^|\/)__tests__\//,
  /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /(^|\/)(playwright|vitest|jest)\.config\.(ts|js|mjs|cjs)$/,
];

const testFiles = allChanged.filter(f => TEST_PATH_PATTERNS.some(re => re.test(f)));

console.error(`Files changed vs origin/main: ${allChanged.length}`);
console.error(`Test-shaped files: ${testFiles.length}`);
for (const f of testFiles) {
  console.error(`  ✓ ${f}`);
}

// INFORMATION channel: write the full report file to ARTIFACTS_DIR.
const reportPath = `${artifactsDir}/test-files-report.json`;
const report = { test_file_count: testFiles.length, files: testFiles };
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.error(`Wrote ${reportPath}`);

if (testFiles.length === 0) {
  console.error('\nNo test files detected in the diff. Test-gen agent produced no testable output.');
  console.error('Listing all changed files for context:');
  for (const f of allChanged) {
    console.error(`    ${f}`);
  }
  // STATE channel: emit the failing status before exiting so `when:` can read it.
  process.stdout.write(
    JSON.stringify({ passed: false, test_file_count: 0, report: reportPath })
  );
  process.exit(1);
}

// STATE channel: small JSON object Archon captures as $node.output.
process.stdout.write(
  JSON.stringify({
    passed: true,
    test_file_count: testFiles.length,
    report: reportPath,
  })
);
