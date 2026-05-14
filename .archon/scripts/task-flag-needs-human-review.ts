#!/usr/bin/env bun
/**
 * Halt path for the NEEDS_DISCUSSION-with-no-auto-fixes case.
 *
 * The synthesizer flagged MEDIUM/LOW issues but none of them are
 * auto-fixable — they're genuine "human decides" calls (style choices,
 * scope debates, tradeoffs the model doesn't want to silently absorb).
 *
 * What this node does:
 *   1. Applies the `archon-needs-review` label to the Jira ticket so the
 *      operator can find it via JQL.
 *   2. Posts a structured Jira comment summarizing the discussion items
 *      with the PR link, so the operator has everything in one place.
 *   3. Does NOT transition the ticket — it stays In Progress until the
 *      operator merges/closes the PR and moves it.
 *   4. Does NOT merge or close the PR. The operator decides.
 *
 * Reads:
 *   $ARTIFACTS_DIR/trigger-payload.json (issue_key)
 *   $ARTIFACTS_DIR/pr-info.json (pr_number, pr_url)
 *   $ARTIFACTS_DIR/review/consolidated-review.md (findings)
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { postWorkflowComment } from './lib/jira-comment.ts';

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

// Load issue key.
const trigger = JSON.parse(
  await readFile(`${artifactsDir}/trigger-payload.json`, 'utf8'),
);
const issueKey: string = trigger.issue_key;

// Load PR info (open-pr ran before parse-synthesis, so this should exist).
let prNumber = '';
let prUrl = '';
const prInfoPath = `${artifactsDir}/pr-info.json`;
if (existsSync(prInfoPath)) {
  const prInfo = JSON.parse(await readFile(prInfoPath, 'utf8'));
  prNumber = String(prInfo.pr_number ?? '');
  prUrl = String(prInfo.pr_url ?? '');
}

// Apply the archon-needs-review label.
const jiraToolPath = '/home/user/Archon/.archon/scripts/jira-tool.js';
const labelInput = JSON.stringify({
  action: 'editLabels',
  issueKey,
  add: ['archon-needs-review'],
});
const labelProc = Bun.spawn(['bun', jiraToolPath, labelInput], {
  stdout: 'pipe',
  stderr: 'pipe',
});
await labelProc.exited;
const labelOut = await new Response(labelProc.stdout).text();
console.error(`label-add result: ${labelOut.trim()}`);

// Read the consolidated review for the comment body.
let reviewBody = '_(consolidated-review.md missing)_';
try {
  reviewBody = await readFile(
    `${artifactsDir}/review/consolidated-review.md`,
    'utf8',
  );
} catch {
  /* fall through with placeholder */
}

// Trim the review body to keep the Jira comment readable. Keep the executive
// summary + statistics + MEDIUM section; drop the verbose LOW table tail.
function trimReview(md: string): string {
  // Cut at the LOW Issues section if present.
  const lowIdx = md.search(/^##\s+LOW\s+Issues/im);
  const head = lowIdx > 0 ? md.slice(0, lowIdx) : md;
  // Hard cap at 6000 chars so the Jira ADF doesn't explode.
  return head.length > 6000 ? head.slice(0, 6000) + '\n\n_(truncated)_' : head;
}

const body = [
  '⚠️ **Synthesis verdict: NEEDS_DISCUSSION** — no auto-fix candidates.',
  '',
  prNumber ? `**PR:** ${prUrl}` : '_(no PR — open-pr did not run)_',
  '',
  'The pipeline halted because the synthesizer flagged MEDIUM/LOW issues that require human judgment (not mechanical fixes). The ticket has been labeled `archon-needs-review`. Review the PR + the findings below and either:',
  '- Merge the PR manually if the findings are acceptable (operator decides).',
  '- Comment on the PR / Jira ticket with guidance and re-trigger if you want auto-fix to attempt them anyway.',
  '- Close the PR and reset the ticket if the work needs to be redone.',
  '',
  '---',
  '',
  trimReview(reviewBody),
].join('\n');

await postWorkflowComment({
  issueKey,
  level: 'paused',
  body,
  fields: {
    pr_number: prNumber,
    pr_url: prUrl,
    verdict: 'NEEDS_DISCUSSION',
    decision: 'needs_human_review',
    auto_fix_count: 0,
  },
});

console.error(
  `Flagged ${issueKey} for human review. PR ${prNumber || '(none)'} left open; ticket left In Progress.`,
);

process.stdout.write(
  JSON.stringify({
    flagged: 'true',
    issue_key: issueKey,
    pr_number: prNumber,
    pr_url: prUrl,
    label_added: 'archon-needs-review',
  }),
);
