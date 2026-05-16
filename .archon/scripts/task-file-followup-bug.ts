#!/usr/bin/env bun
/**
 * Files the followup Bug ticket drafted by `archon-draft-followup-bug`.
 *
 * Reads:
 *   $ARTIFACTS_DIR/followup-bug-draft.json (written by draft-followup-bug)
 *     Shape: { summary, description_markdown, parent_issue_key,
 *              parent_pr_number, parent_pr_url }
 *
 * Side effects:
 *   1. Creates a Bug-type Jira issue in the same project as the parent.
 *   2. Creates an `Action item` link: new ticket "action item from" parent.
 *   3. Transitions the new ticket Backlog → Selected for Development
 *      (fires the bug-pipeline → task-implement chain).
 *   4. Posts a comment on the parent's PR linking the new ticket.
 *
 * Writes (stdout, JSON only):
 *   { "filed": "true", "new_issue_key": "<key>", "parent_issue_key": "<key>" }
 * or on failure:
 *   { "filed": "false", "reason": "<msg>" }
 *
 * Narrative output goes to stderr.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.stdout.write(JSON.stringify({ filed: 'false', reason: 'ARTIFACTS_DIR unset' }));
  process.exit(1);
}

const draftPath = `${artifactsDir}/followup-bug-draft.json`;
if (!existsSync(draftPath)) {
  console.error(`No draft at ${draftPath} — draft-followup-bug did not emit one.`);
  process.stdout.write(JSON.stringify({ filed: 'false', reason: 'no_draft' }));
  process.exit(0);
}

interface BugDraft {
  summary: string;
  description_markdown: string;
  parent_issue_key: string;
  parent_pr_number: number;
  parent_pr_url: string;
}

const draft = JSON.parse(await readFile(draftPath, 'utf8')) as BugDraft;

// Sanity-check the draft. If the agent emitted a partial / malformed file,
// fail loud rather than file a garbage ticket.
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
if (
  !isNonEmptyString(draft.summary) ||
  !isNonEmptyString(draft.description_markdown) ||
  !isNonEmptyString(draft.parent_issue_key)
) {
  console.error('Draft is missing required fields (summary, description_markdown, parent_issue_key).');
  process.stdout.write(
    JSON.stringify({ filed: 'false', reason: 'draft_malformed' }),
  );
  process.exit(0);
}

// Derive the Jira project key from the parent (e.g. "WOR-102" → "WOR").
const projectKey = draft.parent_issue_key.split('-')[0];
if (!projectKey || !/^[A-Z][A-Z0-9_]+$/.test(projectKey)) {
  console.error(`Cannot derive project key from ${draft.parent_issue_key}`);
  process.stdout.write(JSON.stringify({ filed: 'false', reason: 'bad_parent_key' }));
  process.exit(0);
}

const JIRA_TOOL = '/home/user/Archon/.archon/scripts/jira-tool.js';

async function callJiraTool(input: Record<string, unknown>): Promise<unknown> {
  const { stdout } = await execFileAsync('bun', [JIRA_TOOL, JSON.stringify(input)], {
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { ok: boolean; result?: unknown; error?: string };
  if (!parsed.ok) {
    throw new Error(parsed.error ?? 'unknown jira-tool error');
  }
  return parsed.result;
}

// 1. Create the Bug ticket. (jira-tool.js field names: project, issuetype, descriptionMarkdown.)
console.error(`Creating Bug ticket in ${projectKey}: ${draft.summary}`);
const created = (await callJiraTool({
  action: 'createIssue',
  project: projectKey,
  issuetype: 'Bug',
  summary: draft.summary,
  descriptionMarkdown: draft.description_markdown,
})) as { issueKey: string };
// jira-tool.js's runCreateIssue returns { ..., issueKey: <key> } — NOT
// { key }. Reading `.key` here yields undefined, which then makes the
// downstream createIssueLink / transitionIssue calls throw
// assertIssueKey(undefined), get swallowed by their non-fatal
// try/catch, and leave the bug ticket orphaned (created but unlinked,
// stuck in Backlog). Must read `.issueKey`.
const newKey = created.issueKey;
if (!newKey) {
  console.error(
    `createIssue returned no issueKey (got: ${JSON.stringify(created)}). Cannot link or transition.`,
  );
  process.stdout.write(JSON.stringify({ filed: 'false', reason: 'no_issue_key_returned' }));
  process.exit(0);
}
console.error(`Created ${newKey}.`);

// 2. Link as Action item from the parent. jira-tool.js fields: linkType,
//    inwardIssueKey, outwardIssueKey.
//    Direction (per createIssueLink in jira-tool.js semantics, same as the
//    Atlassian API): the inward issue "<inward verb> outward" — for
//    "Action item from", inwardIssue = the ticket that has "action item
//    from" relation (the new bug), outwardIssue = the parent. Result on the
//    new ticket: "Action item from {parent}".
console.error(`Linking ${newKey} as Action item from ${draft.parent_issue_key}`);
try {
  await callJiraTool({
    action: 'createIssueLink',
    linkType: 'Action item',
    inwardIssueKey: newKey,
    outwardIssueKey: draft.parent_issue_key,
  });
} catch (err) {
  // Link failure is non-fatal — the ticket exists, the relationship just
  // isn't visible in Jira. Log and continue.
  console.error(`Link creation failed: ${(err as Error).message}. Continuing.`);
}

// 3. Transition Backlog → Selected for Development. jira-tool.js uses
//    transition NAME via the `toStatus` field (it looks up the id from
//    the per-issue transitions list, case-insensitively).
console.error(`Transitioning ${newKey} → Selected for Development`);
try {
  await callJiraTool({
    action: 'transitionIssue',
    issueKey: newKey,
    toStatus: 'Selected for Development',
  });
} catch (err) {
  console.error(
    `Transition to SfD failed: ${(err as Error).message}. Ticket will need manual transition.`,
  );
}

// 4. Post a comment on the parent's PR linking the followup.
if (draft.parent_pr_number) {
  console.error(`Commenting on parent PR #${draft.parent_pr_number}`);
  const prComment = [
    `🔁 **Auto-filed followup: ${newKey}**`,
    '',
    `The post-fix-validation retry loop on this PR exhausted three attempts; merging this PR with the residual failure and tracking the fix in [${newKey}](https://alphapoint.atlassian.net/browse/${newKey}).`,
    '',
    `${newKey} is an "Action item from" ${draft.parent_issue_key} (visible in Jira's link panel).`,
  ].join('\n');
  try {
    await execFileAsync(
      'gh',
      [
        'pr',
        'comment',
        String(draft.parent_pr_number),
        '--body',
        prComment,
        '--repo',
        // Let gh figure out the repo from the worktree's remote.
      ].filter(Boolean) as string[],
      { env: process.env },
    );
  } catch (err) {
    console.error(
      `gh pr comment failed: ${(err as Error).message}. Continuing.`,
    );
  }
}

console.error(`Filed ${newKey} as followup for ${draft.parent_issue_key}.`);
process.stdout.write(
  JSON.stringify({
    filed: 'true',
    new_issue_key: newKey,
    parent_issue_key: draft.parent_issue_key,
  }),
);
