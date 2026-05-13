#!/usr/bin/env bun
/**
 * Transition the Jira task to Done after the PR has been merged. Posts a final
 * summary comment with elapsed wall-time and the merge SHA.
 *
 * Reads:
 *   $ARTIFACTS_DIR/trigger-payload.json — issue_key
 *   $ARTIFACTS_DIR/pr-info.json — pr_number, pr_url
 *   $ARTIFACTS_DIR/.workflow-start-ms — for elapsed-time framing
 *
 * stdout: { transitioned, issue_key, status }
 */
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { postWorkflowComment, formatElapsed } from './lib/jira-comment';

const execFileAsync = promisify(execFile);

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

const trigger = JSON.parse(await readFile(`${artifactsDir}/trigger-payload.json`, 'utf8')) as {
  issue_key: string;
};

let prNumber = 0;
let prUrl = '';
try {
  const pr = JSON.parse(await readFile(`${artifactsDir}/pr-info.json`, 'utf8')) as {
    pr_number: number;
    pr_url: string;
  };
  prNumber = pr.pr_number;
  prUrl = pr.pr_url;
} catch {
  // pr-info absent — workflow finished without opening one. Fine.
}

let elapsedMs = 0;
try {
  const startMs = parseInt((await readFile(`${artifactsDir}/.workflow-start-ms`, 'utf8')).trim(), 10);
  elapsedMs = Math.max(0, Date.now() - startMs);
} catch {
  // ignore
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

const bodyLines: string[] = [];
bodyLines.push(`task-implement complete. Transitioning to **Done**.`);
if (prUrl || elapsedMs > 0) bodyLines.push('');
if (prUrl) bodyLines.push(`- PR: ${prUrl} (merged into main)`);
if (elapsedMs > 0) bodyLines.push(`- Wall-time: ${formatElapsed(elapsedMs)}`);

console.log(`Posting final summary on ${trigger.issue_key}...`);
await postWorkflowComment({
  issueKey: trigger.issue_key,
  level: 'info',
  body: bodyLines.join('\n'),
  metaFact: elapsedMs > 0 ? `elapsed ${formatElapsed(elapsedMs)}` : undefined,
  fields: {
    from_status: 'In Progress',
    to_status: 'Done',
    pr_number: prNumber || null,
    pr_url: prUrl || null,
    elapsed_ms: elapsedMs,
  },
});

console.log(`Transitioning ${trigger.issue_key} → Done...`);
await callJiraTool({ action: 'transitionIssue', issueKey: trigger.issue_key, toStatus: 'Done' });
console.log('Transition complete.');

process.stdout.write(
  '\n' + JSON.stringify({ transitioned: true, issue_key: trigger.issue_key, status: 'Done' })
);
