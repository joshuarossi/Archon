#!/usr/bin/env bun
/**
 * Handler for a non-Epic Jira issue transitioning to Done.
 *
 * Four responsibilities, in order:
 *
 * 1. Remove this ticket's outward "blocks" links. Each outward Blocks link
 *    on this ticket means "this ticket blocks <other>"; deleting it
 *    automatically removes the matching inward "is blocked by" on <other>.
 *
 * 2. **Action-item cascade.** If this ticket has an outward "Action item"
 *    link, it was filed as a followup that resolves a parent ticket's
 *    residual failure. When it goes Done, the parent is now actually
 *    complete (main has both the parent's PR and this followup's fix).
 *    Transition the parent to Done — and SKIP the sweep-promote step
 *    below, because the parent's own Done event will handle promoting
 *    the next ticket. (If we ran sweep-promote here too, two tickets
 *    would get promoted from one logical completion, breaking
 *    PROMOTE_CAP=1's intent.)
 *
 * 3. Sweep the whole project for Backlog non-Epic tickets that have zero
 *    inward Blocks links remaining, and transition each to
 *    "Selected for Development" (which fires task-tests via jira-router).
 *    Skipped when step 2 cascaded.
 *
 * 4. If this ticket's parent Epic has zero remaining children that are
 *    not Done, transition the Epic to Done.
 *
 * Reads:
 *   $ARTIFACTS_DIR/trigger-payload.json — { issue_key, project, ... }
 * Env:
 *   JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN
 *
 * Writes (stdout, JSON-only — narrative on stderr):
 *   {
 *     "outward_blocks_deleted": N,
 *     "cascade_target": "WOR-102" | null,
 *     "tickets_promoted": [ "WOR-25", ... ],
 *     "epic_completed": "WOR-5" | null
 *   }
 */
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { postWorkflowComment } from './lib/jira-comment';

const execFileAsync = promisify(execFile);

// All narrative goes to stderr so stdout is clean JSON for downstream consumers.
const log = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  log('ARTIFACTS_DIR not set');
  process.exit(1);
}

const baseUrl = process.env.JIRA_BASE_URL;
const userEmail = process.env.JIRA_USER_EMAIL;
const apiToken = process.env.JIRA_API_TOKEN;
if (!baseUrl || !userEmail || !apiToken) {
  log('Missing JIRA_BASE_URL / JIRA_USER_EMAIL / JIRA_API_TOKEN');
  process.exit(1);
}

const auth = `Basic ${Buffer.from(`${userEmail}:${apiToken}`).toString('base64')}`;

interface Trigger {
  issue_key: string;
  project: string;
}

interface IssueLink {
  id: string;
  type: { name: string };
  outwardIssue?: { key: string };
  inwardIssue?: { key: string };
}

interface IssueFields {
  status: { name: string };
  issuetype: { name: string };
  parent?: { key: string };
  issuelinks?: IssueLink[];
}

interface Issue {
  key: string;
  fields: IssueFields;
}

async function jiraGet<T>(path: string): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`GET ${path} failed: ${r.status} ${body.slice(0, 500)}`);
  }
  return (await r.json()) as T;
}

const jiraToolPath = '/home/user/Archon/.archon/scripts/jira-tool.js';

async function jiraToolCall(action: object): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const { stdout } = await execFileAsync('bun', [jiraToolPath, JSON.stringify(action)], {
    maxBuffer: 50 * 1024 * 1024,
  });
  return JSON.parse(stdout) as { ok: boolean; result?: unknown; error?: string };
}

const trigger = JSON.parse(
  await readFile(`${artifactsDir}/trigger-payload.json`, 'utf8'),
) as Trigger;
const { issue_key: thisKey, project } = trigger;
log(`Handling Done transition for ${thisKey} (project ${project}).`);

// 1. Fetch this ticket's outward Blocks links and delete them.
const thisIssue = await jiraGet<Issue>(`/rest/api/3/issue/${thisKey}?fields=issuelinks,parent`);
const outwardBlocks = (thisIssue.fields.issuelinks ?? []).filter(
  l => l.type.name === 'Blocks' && l.outwardIssue !== undefined,
);
log(`Found ${outwardBlocks.length} outward Blocks link(s) to delete.`);

let deletedCount = 0;
for (const link of outwardBlocks) {
  try {
    const res = await jiraToolCall({ action: 'deleteIssueLink', linkId: link.id });
    if (res.ok) {
      deletedCount += 1;
      log(`  ✓ deleted link ${link.id} (${thisKey} blocks ${link.outwardIssue?.key})`);
    } else {
      log(`  ✗ delete link ${link.id} failed: ${res.error}`);
    }
  } catch (e) {
    log(`  ✗ delete link ${link.id} threw: ${(e as Error).message}`);
  }
}

// 2. Action-item cascade. If this ticket has an outward "Action item" link,
//    it was filed as a followup that's responsible for unsticking a parent
//    whose own task-implement run halted after 3 failed post-fix retries.
//    Now that we're going Done, the residual fix is on main. Do what the
//    operator would do by hand:
//      a. Find the parent's open PR (branch convention: archon/task-<key-lc>).
//      b. Squash-merge it.
//      c. Transition the parent to Done.
//    Then SKIP the sweep-promote below — the parent's own Done transition
//    re-fires this handler (where it'll have no outward Action item link),
//    and THAT run does the sweep-promote. Doing it here would double-promote.
const outwardActionItem = (thisIssue.fields.issuelinks ?? []).find(
  l => l.type.name === 'Action item' && l.outwardIssue !== undefined,
);

let cascadeTarget: string | null = null;
let cascadeMergedPr: number | null = null;

if (outwardActionItem?.outwardIssue?.key) {
  const parentKey = outwardActionItem.outwardIssue.key;
  cascadeTarget = parentKey;
  const parentBranch = `archon/task-${parentKey.toLowerCase()}`;
  log(`Action-item cascade: ${thisKey} is an action item from ${parentKey}.`);
  log(`  Looking for parent's open PR on branch ${parentBranch}.`);

  // a. Find the parent's open PR.
  try {
    const { stdout: nameWithOwner } = await execFileAsync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      { cwd: process.cwd() },
    );
    const repo = nameWithOwner.trim();
    const { stdout: prListJson } = await execFileAsync(
      'gh',
      [
        'pr', 'list',
        '--repo', repo,
        '--head', parentBranch,
        '--state', 'open',
        '--json', 'number,url,state',
      ],
      { cwd: process.cwd() },
    );
    const prs = JSON.parse(prListJson) as Array<{ number: number; url: string; state: string }>;
    if (prs.length === 0) {
      log(`  ✗ No open PR found for parent branch ${parentBranch}. Falling through to normal sweep.`);
    } else {
      const parentPr = prs[0];
      log(`  Found PR #${parentPr.number} (${parentPr.url}). Squash-merging.`);

      // b. Squash-merge the parent's PR.
      const { stdout: mergeOut } = await execFileAsync(
        'gh',
        ['pr', 'merge', String(parentPr.number), '--squash', '--delete-branch', '--repo', repo],
        { cwd: process.cwd(), maxBuffer: 50 * 1024 * 1024 },
      );
      log(`  ${mergeOut.trim()}`);
      cascadeMergedPr = parentPr.number;

      // c. Transition the parent to Done. (This Done transition will re-fire
      //    jira-task-done.ts — that run will see no outward Action item and
      //    will do the normal sweep-promote.)
      log(`  Transitioning ${parentKey} → Done.`);
      const transitionRes = await jiraToolCall({
        action: 'transitionIssue',
        issueKey: parentKey,
        toStatus: 'Done',
      });
      if (!transitionRes.ok) {
        log(`  ✗ Parent transition failed: ${transitionRes.error}`);
      } else {
        await postWorkflowComment({
          issueKey: parentKey,
          level: 'info',
          body: [
            `🔁 **Auto-cascade from ${thisKey}.**`,
            ``,
            `${thisKey} was an Action item filed when this ticket's task-implement run failed three post-fix-validation retries. ${thisKey} merged its fix to main (PR #${cascadeMergedPr}), unsticking the path. This ticket's PR has now been squash-merged and the ticket transitioned to Done — same effect as if the original retries had succeeded.`,
          ].join('\n'),
          fields: {
            cascade_from: thisKey,
            parent_pr_merged: cascadeMergedPr,
            cascade_at: new Date().toISOString(),
          },
        }).catch(() => undefined);
      }

      // Skip sweep-promote on THIS run; the parent's Done event handles it.
      log(`  Cascade complete. Skipping sweep-promote on this run.`);
      // Also skip Epic completion check — the parent's run will handle it.
      const bodyLines = [
        `Done handler ran on ${thisKey} (action-item cascade path).`,
        ``,
        `- Outward Blocks links deleted: **${deletedCount}**`,
        `- Cascade target (parent): **${parentKey}**`,
        `- Parent PR merged: **#${cascadeMergedPr}**`,
        `- Sweep-promote: **skipped** (parent's Done event handles it)`,
      ];
      await postWorkflowComment({
        issueKey: thisKey,
        level: 'info',
        body: bodyLines.join('\n'),
        fields: {
          outward_blocks_deleted: deletedCount,
          cascade_target: parentKey,
          parent_pr_merged: cascadeMergedPr,
          sweep_promote_skipped: true,
        },
      }).catch(() => undefined);

      process.stdout.write(
        JSON.stringify({
          outward_blocks_deleted: deletedCount,
          cascade_target: parentKey,
          parent_pr_merged: cascadeMergedPr,
          tickets_promoted: [],
          epic_completed: null,
        }),
      );
      process.exit(0);
    }
  } catch (e) {
    log(`  ✗ Cascade failed: ${(e as Error).message}. Falling through to normal sweep.`);
  }
}

// 3. Sweep the project: find Backlog non-Epic tickets and promote any with
//    zero inward Blocks links to Selected for Development.
//
// TEMPORARY WIP CAP: promote at most ONE ticket per Done event. Lifts
// concurrency pressure while we debug stuck tickets. Remove the
// `break` below to restore the unbounded promote-all behavior.
const PROMOTE_CAP = 1;
log(`Sweeping ${project} for Backlog tickets with no remaining blockers (cap=${PROMOTE_CAP}).`);

interface SearchResponse {
  issues: Issue[];
}

// Exclude tickets bearing `archon-blocked-pending` from promotion. That label
// is the human-controlled "leave this alone for now" pause signal — when it
// is set, a ticket sits in Backlog forever (no router event fires) until a
// human removes the label by hand.
//
// JQL gotcha: `labels != X` is interpreted as "labels exist AND none equal
// X", which silently EXCLUDES tickets with no labels at all. The correct
// "doesn't have this specific label" form is `(labels is EMPTY OR labels
// not in (X))` — accepts both unlabeled and differently-labeled rows.
// ORDER BY key ASC so the lowest-numbered Backlog ticket gets picked
// first. With WIP=1 this means we work tickets in the order they were
// decomposed (typically follows dependency order from the Epic plan),
// instead of whatever default sort Jira would otherwise apply.
const jql = encodeURIComponent(
  `project = ${project} AND status = "Backlog" AND issuetype != Epic AND (labels is EMPTY OR labels not in ("archon-blocked-pending")) ORDER BY key ASC`,
);
const searchPath = `/rest/api/3/search/jql?jql=${jql}&fields=issuelinks,issuetype,status,labels&maxResults=200`;
const searchResult = await jiraGet<SearchResponse>(searchPath);
log(`  ${searchResult.issues.length} Backlog non-Epic, non-paused ticket(s) in project.`);

const promoted: string[] = [];
for (const candidate of searchResult.issues) {
  // Inward "is blocked by" links — even one means still blocked.
  const inwardBlocks = (candidate.fields.issuelinks ?? []).filter(
    l => l.type.name === 'Blocks' && l.inwardIssue !== undefined,
  );
  if (inwardBlocks.length > 0) {
    log(`  ${candidate.key}: still blocked by ${inwardBlocks.length} (skip)`);
    continue;
  }
  log(`  ${candidate.key}: no remaining blockers — promoting.`);
  try {
    const res = await jiraToolCall({
      action: 'transitionIssue',
      issueKey: candidate.key,
      toStatus: 'Selected for Development',
    });
    if (res.ok) {
      promoted.push(candidate.key);
      await postWorkflowComment({
        issueKey: candidate.key,
        level: 'info',
        body: `Promoted to **Selected for Development** — no remaining blockers (triggered by ${thisKey} → Done).`,
        fields: {
          from_status: 'Backlog',
          to_status: 'Selected for Development',
          triggered_by: thisKey,
        },
      }).catch(() => undefined);
      if (promoted.length >= PROMOTE_CAP) {
        log(`  WIP cap reached (${PROMOTE_CAP}); deferring further promotions to subsequent Done events.`);
        break;
      }
    } else {
      log(`    ✗ transition failed: ${res.error}`);
    }
  } catch (e) {
    log(`    ✗ transition threw: ${(e as Error).message}`);
  }
}

// 3. If this ticket has a parent Epic and the Epic has zero remaining
//    non-Done children, mark the Epic Done too.
let epicCompleted: string | null = null;
const parentKey = thisIssue.fields.parent?.key;
if (parentKey) {
  log(`Checking parent Epic ${parentKey} for completion.`);
  // Children of the Epic that are NOT Done.
  const childJql = encodeURIComponent(`parent = ${parentKey} AND status != "Done"`);
  const childPath = `/rest/api/3/search/jql?jql=${childJql}&fields=status&maxResults=500`;
  const childResult = await jiraGet<SearchResponse>(childPath);
  // The just-completed ticket may not yet show as Done in the index — exclude
  // it explicitly so a single straggling-index race doesn't keep the Epic open.
  const remaining = childResult.issues.filter(c => c.key !== thisKey);
  log(`  Parent ${parentKey} has ${remaining.length} non-Done child(ren) remaining.`);
  if (remaining.length === 0) {
    log(`  All children Done — transitioning ${parentKey} to Done.`);
    try {
      const res = await jiraToolCall({
        action: 'transitionIssue',
        issueKey: parentKey,
        toStatus: 'Done',
      });
      if (res.ok) {
        epicCompleted = parentKey;
        await postWorkflowComment({
          issueKey: parentKey,
          level: 'info',
          body: `Epic completed — all child tickets reached **Done**. Last was ${thisKey}.`,
          fields: {
            from_status: 'In Progress',
            to_status: 'Done',
            last_child: thisKey,
          },
        }).catch(() => undefined);
      } else {
        log(`    ✗ epic transition failed: ${res.error}`);
      }
    } catch (e) {
      log(`    ✗ epic transition threw: ${(e as Error).message}`);
    }
  }
}

const bodyLines = [
  `Done handler ran on ${thisKey}.`,
  ``,
  `- Outward Blocks links deleted: **${deletedCount}**`,
  `- Tickets promoted to Selected for Development: **${promoted.length}**${promoted.length > 0 ? ` (${promoted.join(', ')})` : ''}`,
  `- Parent Epic completed: ${epicCompleted ? `**${epicCompleted}**` : 'no'}`,
];
await postWorkflowComment({
  issueKey: thisKey,
  level: 'info',
  body: bodyLines.join('\n'),
  fields: {
    outward_blocks_deleted: deletedCount,
    tickets_promoted: promoted,
    promote_cap: PROMOTE_CAP,
    epic_completed: epicCompleted,
    parent_key: parentKey ?? null,
  },
}).catch(() => undefined);

process.stdout.write(
  JSON.stringify({
    outward_blocks_deleted: deletedCount,
    tickets_promoted: promoted,
    epic_completed: epicCompleted,
  }),
);
