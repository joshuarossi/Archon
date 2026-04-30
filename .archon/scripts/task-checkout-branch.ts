#!/usr/bin/env bun
/**
 * Verify the worktree is on a feature branch (created by Archon's isolation
 * system as part of the worktree provisioning) and fetch any commits that
 * task-tests previously pushed to that branch on origin. Records the actual
 * branch name + base sha for downstream nodes.
 *
 * Archon's worktree provisioning creates a branch like archon/task-<slug>
 * named after the workflow's --branch argument. We don't construct that name;
 * we read it from the worktree's actual HEAD.
 *
 * stdout: { branch, current_sha, base_sha }
 */
import { writeFile } from 'node:fs/promises';
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
    const { stdout } = await execFileAsync('git', args, { cwd: process.cwd() });
    return stdout.trim();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const detail = (err.stderr || err.stdout || err.message || String(e)).trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

console.log(`Inspecting worktree at ${process.cwd()}.`);

const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
console.log(`Current branch (Archon-managed): ${branch}`);

if (branch === 'HEAD' || branch === 'main' || branch === 'master') {
  throw new Error(
    `Worktree is on '${branch}' instead of a feature branch. Archon's isolation should have placed it on a feature branch.`
  );
}

console.log(`Fetching latest commits for ${branch} from origin...`);
try {
  await git('fetch', 'origin', branch);
  // Fast-forward to origin's tip if origin has commits we're missing (e.g.,
  // task-tests pushed commits before this worktree was created).
  const localSha = await git('rev-parse', 'HEAD');
  const remoteSha = await git('rev-parse', `origin/${branch}`);
  if (localSha !== remoteSha) {
    console.log(`Local HEAD (${localSha.slice(0, 8)}) differs from origin/${branch} (${remoteSha.slice(0, 8)}). Resetting to origin.`);
    await git('reset', '--hard', `origin/${branch}`);
  } else {
    console.log(`Local and origin both at ${localSha.slice(0, 8)} — already in sync.`);
  }
} catch (e) {
  console.log(`Could not fetch ${branch} from origin (${(e as Error).message}). Continuing with local state.`);
}

const currentSha = await git('rev-parse', 'HEAD');

let baseSha = currentSha;
try {
  await git('fetch', 'origin', 'main');
  baseSha = await git('merge-base', currentSha, 'origin/main');
} catch (e) {
  console.log(`Could not compute merge-base with origin/main: ${(e as Error).message}`);
}

await writeFile(`${artifactsDir}/branch-name.txt`, branch);
await writeFile(`${artifactsDir}/base-sha.txt`, baseSha);

console.log(`Branch ${branch} at ${currentSha.slice(0, 8)} (base ${baseSha.slice(0, 8)}).`);
console.log('Worktree ready for dev loop.');

process.stdout.write(
  '\n' + JSON.stringify({ branch, current_sha: currentSha, base_sha: baseSha })
);
