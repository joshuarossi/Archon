#!/usr/bin/env bun
/**
 * Transition a Jira task from Selected for Development → In Progress and post
 * a confirmation comment summarizing what test-gen produced. The transition
 * itself fires the next webhook (which will eventually trigger task-implement).
 *
 * Reads:
 *   $ARTIFACTS_DIR/trigger-payload.json — issue_key
 *   $ARTIFACTS_DIR/test-files-report.json (optional) — to enrich the comment
 *   $ARTIFACTS_DIR/commit-push-report.json (optional) — for branch + sha
 *
 * stdout: { transitioned, comment_posted, issue_key }
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

const trigger = JSON.parse(
  await readFile(`${artifactsDir}/trigger-payload.json`, 'utf8')
) as { issue_key: string };

let testFileCount = 0;
let testFiles: string[] = [];
try {
  const r = JSON.parse(await readFile(`${artifactsDir}/test-files-report.json`, 'utf8')) as {
    test_file_count: number;
    files: string[];
  };
  testFileCount = r.test_file_count;
  testFiles = r.files;
} catch {
  // optional
}

let branch = trigger.issue_key;
let sha = '';
try {
  const r = JSON.parse(await readFile(`${artifactsDir}/commit-push-report.json`, 'utf8')) as {
    sha: string;
  };
  sha = r.sha;
} catch {
  // optional
}

async function callJiraTool(input: object): Promise<unknown> {
  const json = JSON.stringify(input);
  try {
    const { stdout } = await execFileAsync('bun', ['/home/user/Archon/.archon/scripts/jira-tool.js', json], {
      maxBuffer: 50 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { ok: boolean; result: unknown; error?: string };
    if (!parsed.ok) throw new Error(parsed.error ?? stdout);
    return parsed.result;
  } catch (e) {
    const err = e as { stdout?: string; message?: string };
    throw new Error(err.stdout ?? err.message ?? String(e));
  }
}

const commentLines = [
  `Autonomous: test-gen complete.`,
  '',
  `- ${testFileCount} test file(s) written and committed.`,
  `- Branch: \`${branch}\`${sha ? ` at \`${sha.slice(0, 8)}\`` : ''}.`,
];
if (testFiles.length > 0 && testFiles.length <= 10) {
  commentLines.push('- Files:');
  for (const f of testFiles) commentLines.push(`    - \`${f}\``);
}
commentLines.push('');
commentLines.push('Transitioning to In Progress so the dev agent can begin implementation. The dev agent has no read access to the test files — its job is to satisfy the ACs honestly.');

const comment = commentLines.join('\n');

console.log(`Posting comment on ${trigger.issue_key}...`);
await callJiraTool({ action: 'addComment', issueKey: trigger.issue_key, text: comment });
console.log('Comment posted.');

console.log(`Transitioning ${trigger.issue_key} → In Progress...`);
await callJiraTool({
  action: 'transitionIssue',
  issueKey: trigger.issue_key,
  toStatus: 'In Progress',
});
console.log('Transition complete. The next webhook will fire task-implement.');

process.stdout.write(
  '\n' + JSON.stringify({ transitioned: true, comment_posted: true, issue_key: trigger.issue_key })
);
