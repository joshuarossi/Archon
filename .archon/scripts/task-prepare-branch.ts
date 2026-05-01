#!/usr/bin/env bun
/**
 * Verify we're inside Archon's worktree on the auto-generated isolation branch,
 * record the branch name for downstream nodes, and exit. Archon's isolation
 * system has already done all the git work (worktree creation, branch checkout
 * from main); we just confirm and record state.
 *
 * No push happens here — the branch is local to the worktree until a downstream
 * step (PR creation) explicitly pushes it.
 *
 * stdout: { branch, base_sha, current_sha, cwd }
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

interface TriggerPayload {
  issue_key: string;
}
const trigger: TriggerPayload = JSON.parse(await readFile(`${artifactsDir}/trigger-payload.json`, 'utf8'));

async function git(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: process.cwd() });
    return stdout.trim();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const detail = (err.stderr || err.stdout || err.message || String(e)).trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

console.log(`Verifying worktree state for ${trigger.issue_key}.`);
console.log(`Working directory: ${process.cwd()}`);

const currentBranch = await git('rev-parse', '--abbrev-ref', 'HEAD');
const currentSha = await git('rev-parse', 'HEAD');
console.log(`On branch: ${currentBranch} at ${currentSha.slice(0, 8)}`);

// Determine the merge-base with main so downstream steps can diff against it.
let baseSha = currentSha;
try {
  await git('fetch', 'origin', 'main');
  baseSha = await git('merge-base', currentSha, 'origin/main');
  console.log(`Merge-base with origin/main: ${baseSha.slice(0, 8)}`);
} catch (e) {
  console.log(`Could not compute merge-base with origin/main: ${(e as Error).message}`);
  console.log(`Falling back to current HEAD as base.`);
}

// Record the branch name and base sha for downstream nodes (commit/push, PR creation, etc.).
await writeFile(`${artifactsDir}/branch-name.txt`, currentBranch);
await writeFile(`${artifactsDir}/base-sha.txt`, baseSha);

console.log(`Recorded branch-name.txt and base-sha.txt for downstream nodes.`);
console.log(`Worktree is ready for test-gen.`);

process.stdout.write(
  '\n' +
    JSON.stringify({
      branch: currentBranch,
      base_sha: baseSha,
      current_sha: currentSha,
      cwd: process.cwd(),
    })
);
