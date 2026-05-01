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
 * stdout: { test_file_count, files }
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

console.log('Diffing working tree against origin/main to find test files...');

// Include both committed and uncommitted changes — depending on agent ordering
// the tests might be staged-but-not-committed when this runs.
// `git diff origin/main --name-only` covers committed changes;
// `git status --porcelain` covers uncommitted ones.
const committedFiles = (await git('diff', 'origin/main', '--name-only')).split('\n').filter(Boolean);
const statusOut = (await git('status', '--porcelain')).split('\n').filter(Boolean);
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

console.log(`Files changed vs origin/main: ${allChanged.length}`);
console.log(`Test-shaped files: ${testFiles.length}`);
for (const f of testFiles) {
  console.log(`  ✓ ${f}`);
}

if (testFiles.length === 0) {
  console.error('\nNo test files detected in the diff. Test-gen agent produced no testable output.');
  console.error('Listing all changed files for context:');
  for (const f of allChanged) {
    console.error(`    ${f}`);
  }
  process.exit(1);
}

process.stdout.write(
  '\n' + JSON.stringify({ test_file_count: testFiles.length, files: testFiles })
);
