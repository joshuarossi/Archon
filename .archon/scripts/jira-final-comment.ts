#!/usr/bin/env bun
/**
 * Post a final summary comment on the Epic after task creation, linking, and
 * unblocking are complete. Reads the artifact reports and constructs a deterministic
 * summary — no LLM authoring needed since the content is purely a status report.
 *
 * Inputs:
 *   $ARTIFACTS_DIR/trigger-payload.json — Epic key
 *   $ARTIFACTS_DIR/task-keymap.json — { task_id: jira_key }
 *   $ARTIFACTS_DIR/decomposition-plan.json — for total task count cross-check
 *   $ARTIFACTS_DIR/blocks-links-report.json — link creation results
 *   $ARTIFACTS_DIR/unblock-roots-report.json — which keys transitioned
 *
 * stdout: { posted: true, epic: <key>, comment_summary: { ... } }
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

interface TriggerPayload {
  issue_key: string;
}
type Keymap = Record<string, string>;

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

const trigger: TriggerPayload = JSON.parse(await readWithRetry(`${artifactsDir}/trigger-payload.json`));
const keymap: Keymap = JSON.parse(await readWithRetry(`${artifactsDir}/task-keymap.json`));
console.log(`Composing final summary comment on Epic ${trigger.issue_key}...`);

const created = Object.entries(keymap);
const createdKeys = created.map(([, k]) => k).sort((a, b) => {
  // Sort numerically by trailing key number (PROJ-12 < PROJ-100).
  const na = parseInt(a.split('-').pop() ?? '0', 10);
  const nb = parseInt(b.split('-').pop() ?? '0', 10);
  return na - nb;
});
const minKey = createdKeys[0];
const maxKey = createdKeys[createdKeys.length - 1];

let blocksLinkedCount = 0;
try {
  const blocks = JSON.parse(await readFile(`${artifactsDir}/blocks-links-report.json`, 'utf8'));
  if (Array.isArray(blocks.results)) {
    blocksLinkedCount = blocks.results.filter((r: { ok: boolean }) => r.ok).length;
  } else if (typeof blocks.count === 'number') {
    blocksLinkedCount = blocks.count;
  }
} catch {
  // No report (e.g. zero deps in plan) — leave count at 0.
}

let rootsTransitioned: string[] = [];
try {
  const unblockReport = JSON.parse(await readFile(`${artifactsDir}/unblock-roots-report.json`, 'utf8'));
  // The report is the inner `parsed.result` object from jira-tool batch — extract transitioned keys
  // from its operations. We stored it as the batch result, which has results[] per op.
  // Look for transitionIssue ops that succeeded.
  if (Array.isArray(unblockReport.results)) {
    rootsTransitioned = unblockReport.results
      .filter((r: { ok: boolean; action: string; result?: { issueKey?: string } }) => r.ok && r.action === 'transitionIssue')
      .map((r: { result?: { issueKey?: string } }) => r.result?.issueKey)
      .filter(Boolean);
  }
} catch {
  // ignore
}

const total = created.length;
const summaryLines: string[] = [];
summaryLines.push(`Epic decomposition complete. Created ${total} tasks (${minKey}–${maxKey}) under ${trigger.issue_key}.`);
summaryLines.push('');
summaryLines.push(`Dependency graph: ${blocksLinkedCount} Blocks links created.`);
if (rootsTransitioned.length > 0) {
  summaryLines.push(
    `Unblocked and transitioned to Selected for Development: ${rootsTransitioned.join(', ')}. These will trigger the test-gen pipeline immediately.`
  );
} else {
  summaryLines.push('No root tasks were transitioned (every task declared a blocker).');
}
summaryLines.push('');
summaryLines.push(
  'All other tasks remain in Backlog. Each will move to Selected for Development automatically once its blockers reach Done.'
);

const text = summaryLines.join('\n');

async function callJiraTool(input: object): Promise<void> {
  const json = JSON.stringify(input);
  try {
    const { stdout } = await execFileAsync('bun', ['/home/user/Archon/.archon/scripts/jira-tool.js', json], {
      maxBuffer: 50 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { ok: boolean; error?: string };
    if (!parsed.ok) throw new Error(parsed.error ?? stdout);
  } catch (e) {
    const err = e as { stdout?: string; message?: string };
    throw new Error(err.stdout ?? err.message ?? String(e));
  }
}

console.log(`Summary: ${total} tasks (${minKey}–${maxKey}), ${blocksLinkedCount} Blocks links, ${rootsTransitioned.length} root(s) transitioned.`);
console.log('Posting comment to Epic...');
await callJiraTool({ action: 'addComment', issueKey: trigger.issue_key, text });
console.log('Final summary comment posted. Epic decomposition workflow complete.');

process.stdout.write(
  '\n' +
    JSON.stringify({
      posted: true,
      epic: trigger.issue_key,
      comment_summary: { tasks_created: total, blocks_linked: blocksLinkedCount, roots_transitioned: rootsTransitioned.length },
    })
);
