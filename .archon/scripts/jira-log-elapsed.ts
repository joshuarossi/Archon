#!/usr/bin/env bun
/**
 * Compute the workflow's total elapsed time (start-ms file written by the first node
 * vs. now) and log it as a worklog entry on the Epic. Makes autonomous effort visible
 * in Jira's standard time-tracking reports.
 *
 * Inputs:
 *   $ARTIFACTS_DIR/.workflow-start-ms — Unix epoch ms, written by `decode` node.
 *   $ARTIFACTS_DIR/trigger-payload.json — Epic key.
 *   $ARTIFACTS_DIR/task-keymap.json — for stat color in the comment.
 *
 * stdout: { logged, elapsed_seconds, worklog_id, epic, comment }
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

async function readWithRetry(p: string, attempts = 5, delayMs = 500): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await readFile(p, 'utf8');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT' || i === attempts - 1) throw e;
      console.log(`  (waiting for ${p}, attempt ${i + 1}/${attempts}...)`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}

const trigger = JSON.parse(await readWithRetry(`${artifactsDir}/trigger-payload.json`)) as {
  issue_key: string;
};

let startMs: number;
try {
  const raw = await readFile(`${artifactsDir}/.workflow-start-ms`, 'utf8');
  startMs = parseInt(raw.trim(), 10);
  if (!Number.isFinite(startMs) || startMs <= 0) throw new Error(`bad start-ms value: ${raw}`);
} catch (e) {
  console.error(`Could not read workflow start time: ${(e as Error).message}`);
  process.exit(1);
}

const elapsedMs = Date.now() - startMs;
const elapsedSeconds = Math.max(60, Math.round(elapsedMs / 1000));
const elapsedMinutes = Math.round(elapsedSeconds / 60);

// Workflow name from env (each workflow exports it before invoking this script).
const workflowName = process.env.WORKFLOW_NAME ?? 'workflow';

// Best-effort enrichment per workflow: epic-decompose carries a keymap.
let extra = '';
try {
  const keymap = JSON.parse(await readFile(`${artifactsDir}/task-keymap.json`, 'utf8'));
  const tasksCreated = Object.keys(keymap).length;
  if (tasksCreated > 0) {
    extra = ` Created ${tasksCreated} child tasks, dependency-linked them, transitioned root tasks to Selected for Development.`;
  }
} catch {
  // not present in non-decomposition workflows
}

const comment = `Autonomous: ${workflowName} workflow run.${extra} Total elapsed: ${elapsedMinutes}m.`;

console.log(`Logging ${elapsedSeconds}s (${elapsedMinutes}m) of autonomous work against ${trigger.issue_key} (${workflowName}).`);
console.log(`Comment: "${comment}"`);

const input = JSON.stringify({
  action: 'addWorklog',
  issueKey: trigger.issue_key,
  timeSpentSeconds: elapsedSeconds,
  comment,
});

let stdout: string;
try {
  ({ stdout } = await execFileAsync('bun', ['/home/user/Archon/.archon/scripts/jira-tool.js', input], {
    maxBuffer: 50 * 1024 * 1024,
  }));
} catch (e) {
  const err = e as { stdout?: string; message?: string };
  process.stderr.write(`jira-tool failed: ${err.stdout ?? err.message ?? String(e)}\n`);
  process.exit(1);
}
const parsed = JSON.parse(stdout) as {
  ok: boolean;
  result: { worklogId?: string; timeSpentSeconds: number };
  error?: string;
};
if (!parsed.ok) {
  process.stderr.write(stdout);
  process.exit(1);
}

console.log(`Worklog posted (id ${parsed.result.worklogId ?? 'unknown'}). Visible in Jira's time-tracking reports for ${trigger.issue_key}.`);

process.stdout.write(
  '\n' +
    JSON.stringify({
      logged: true,
      elapsed_seconds: elapsedSeconds,
      worklog_id: parsed.result.worklogId,
      epic: trigger.issue_key,
      comment,
    })
);
