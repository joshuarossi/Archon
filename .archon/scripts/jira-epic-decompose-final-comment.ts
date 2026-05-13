#!/usr/bin/env bun
/**
 * Final summary comment on the Epic after `epic-decompose` finishes
 * creating child tasks and linking the dependency graph. Posts a
 * PAUSED-checkpoint comment so the operator knows tickets are waiting
 * for human release (every ticket retains `archon-blocked-pending`;
 * `jira-task-done` sweep ignores labeled tickets).
 *
 * Reads:
 *   $ARTIFACTS_DIR/trigger-payload.json — Epic issue_key
 *   $ARTIFACTS_DIR/task-keymap.json — { task_id: jira_key }
 *   $ARTIFACTS_DIR/blocks-links-report.json (optional) — count of Blocks
 *     links created in `create-blocks-links`
 *   $ARTIFACTS_DIR/.workflow-start-ms (optional) — for elapsed framing
 *
 * Output: stdout = JSON pointer for the workflow runtime.
 */
import { readFile } from 'node:fs/promises';
import { postWorkflowComment, formatElapsed } from './lib/jira-comment';

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

const trigger = JSON.parse(
  await readFile(`${artifactsDir}/trigger-payload.json`, 'utf8'),
) as { issue_key: string };
const keymap = JSON.parse(
  await readFile(`${artifactsDir}/task-keymap.json`, 'utf8'),
) as Record<string, string>;

const createdKeys = Object.values(keymap);
const total = createdKeys.length;
const numericSort = (a: string, b: string): number =>
  parseInt(a.split('-').pop() ?? '0', 10) - parseInt(b.split('-').pop() ?? '0', 10);
const sortedKeys = [...createdKeys].sort(numericSort);
const minKey = sortedKeys[0] ?? '';
const maxKey = sortedKeys[sortedKeys.length - 1] ?? '';

let blocksLinkedCount = 0;
try {
  const blocks = JSON.parse(
    await readFile(`${artifactsDir}/blocks-links-report.json`, 'utf8'),
  ) as { results?: Array<{ ok: boolean }>; count?: number };
  if (Array.isArray(blocks.results)) {
    blocksLinkedCount = blocks.results.filter(r => r.ok).length;
  } else if (typeof blocks.count === 'number') {
    blocksLinkedCount = blocks.count;
  }
} catch {
  // optional
}

let elapsedMs = 0;
try {
  const startMs = parseInt(
    (await readFile(`${artifactsDir}/.workflow-start-ms`, 'utf8')).trim(),
    10,
  );
  elapsedMs = Math.max(0, Date.now() - startMs);
} catch {
  // optional
}

const body = [
  `Epic decomposition complete. Created **${total}** tasks (\`${minKey}\`–\`${maxKey}\`) with **${blocksLinkedCount}** Blocks links.`,
  '',
  '**PAUSED — operator checkpoint.** All tasks remain in Backlog with the',
  '`archon-blocked-pending` label. `jira-task-done` respects this label and will',
  'not auto-promote any ticket. Review the plan + tickets, then release work by',
  'removing the label from one root task and transitioning it to **Selected for',
  "Development** by hand. Subsequent tickets release one-at-a-time as their",
  'blockers reach **Done**.',
].join('\n');

await postWorkflowComment({
  issueKey: trigger.issue_key,
  level: 'paused',
  metaFact: elapsedMs > 0 ? `elapsed ${formatElapsed(elapsedMs)}` : undefined,
  body,
  fields: {
    tasks_created: total,
    first_key: minKey,
    last_key: maxKey,
    blocks_links: blocksLinkedCount,
    elapsed_ms: elapsedMs,
    paused: true,
    pause_label: 'archon-blocked-pending',
  },
});

process.stdout.write(
  JSON.stringify({
    posted: true,
    epic: trigger.issue_key,
    tasks_created: total,
    blocks_linked: blocksLinkedCount,
    paused: true,
  }),
);
