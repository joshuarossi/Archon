#!/usr/bin/env bun
/**
 * Squash-merge the PR that was opened earlier in this workflow, delete the
 * branch on origin, and post a confirmation comment on the Jira ticket.
 *
 * Reads:
 *   $ARTIFACTS_DIR/pr-info.json — pr_url, pr_number, branch
 *   $ARTIFACTS_DIR/trigger-payload.json — for issue_key (Jira comment)
 *
 * stdout: { merged, sha, pr_number, pr_url }
 */
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

const trigger = JSON.parse(await readFile(`${artifactsDir}/trigger-payload.json`, 'utf8')) as {
  issue_key: string;
};
const prInfo = JSON.parse(await readFile(`${artifactsDir}/pr-info.json`, 'utf8')) as {
  pr_url: string;
  pr_number: number;
  branch: string;
};

console.log(`Merging PR #${prInfo.pr_number} (${prInfo.pr_url})...`);

let mergeSha = '';
try {
  // squash + delete branch on origin. Pass --repo so gh operates against the
  // remote without trying to update the local checkout (which would conflict
  // with `main` checked out elsewhere).
  const repoFromUrl = await execFileAsync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: process.cwd() });
  const nameWithOwner = repoFromUrl.stdout.trim();
  const { stdout } = await execFileAsync(
    'gh',
    ['pr', 'merge', String(prInfo.pr_number), '--squash', '--delete-branch', '--auto', '--repo', nameWithOwner],
    { cwd: process.cwd(), maxBuffer: 50 * 1024 * 1024 }
  );
  console.log(stdout);

  // gh pr merge doesn't always print the SHA; fetch it after
  const { stdout: prJson } = await execFileAsync(
    'gh',
    ['pr', 'view', String(prInfo.pr_number), '--json', 'mergeCommit,state,mergedAt', '--repo', nameWithOwner],
    { cwd: process.cwd() }
  );
  const parsed = JSON.parse(prJson) as {
    mergeCommit?: { oid?: string };
    state: string;
    mergedAt: string | null;
  };
  if (parsed.state !== 'MERGED') {
    console.error(`PR did not reach MERGED state — current state: ${parsed.state}.`);
    process.exit(1);
  }
  mergeSha = parsed.mergeCommit?.oid ?? '';
  console.log(`PR merged at ${parsed.mergedAt}, merge commit ${mergeSha.slice(0, 8)}.`);
} catch (e) {
  const err = e as { stdout?: string; stderr?: string; message?: string };
  console.error(`gh pr merge failed: ${err.stderr ?? err.stdout ?? err.message}`);
  process.exit(1);
}

// Post a Jira comment linking the merge.
console.log(`Posting merge confirmation to ${trigger.issue_key}...`);
const commentInput = JSON.stringify({
  action: 'addComment',
  issueKey: trigger.issue_key,
  text: `PR #${prInfo.pr_number} merged: ${prInfo.pr_url} (commit ${mergeSha.slice(0, 8)})`,
});
try {
  await execFileAsync('bun', ['/home/user/Archon/.archon/scripts/jira-tool.js', commentInput], {
    maxBuffer: 50 * 1024 * 1024,
  });
} catch (e) {
  const err = e as { stdout?: string; message?: string };
  console.error(`Jira comment failed (merge succeeded though): ${err.stdout ?? err.message}`);
}

process.stdout.write(
  '\n' +
    JSON.stringify({
      merged: true,
      sha: mergeSha,
      pr_number: prInfo.pr_number,
      pr_url: prInfo.pr_url,
    })
);
