# Archie Jira-comment format spec

**When to read this:** before editing or adding any Jira comment emitter
(scripts under `.archon/scripts/`, comment-emit nodes in workflows under
`.archon/workflows/defaults/`, or any prompt that tells an agent to post a
Jira comment via `jira-tool.js`). This is the canonical contract for what
a Jira comment from Archie looks like. The goal is to make a ticket's
comment thread a useful runtime log of what happened — not a dumping
ground of `console.log`-style narration.

Companion: the implementation library lives at
`.archon/scripts/lib/jira-comment.ts`. Every Jira comment Archie posts
should go through it. The agent-prompt sites (e.g. the per-ticket
creation comment in `process-tasks`) format the same way; they just
build the string inline because the agent doesn't import library code.

---

## The shape

Every comment has three parts: **header**, **body**, **payload**.

```
{emoji} {workflow} / {node}
run {short_run_id} · {iso_timestamp} · {optional metadata}

{body — 1–6 lines of human-readable summary in markdown}

```json
{ structured payload — see below }
```
```

A worked example, routine state-transition on a child ticket:

```
🟢 task-implement / open-pr
run 8a3f12bc · 2026-05-13T18:42:11Z · elapsed 12m44s

Opened PR #142 in joshuarossi/Clarity:
**T17 — Top navigation component (TopNav, PhaseHeader, authenticated nav shell)**

- Branch: `archon/task-wor-91`
- Base: `main`
- Files changed: 7

```json
{
  "level": "info",
  "workflow": "task-implement",
  "node": "open-pr",
  "run_id": "8a3f12bc",
  "issue_key": "WOR-91",
  "fields": {
    "pr_number": 142,
    "pr_url": "https://github.com/joshuarossi/Clarity/pull/142",
    "branch": "archon/task-wor-91",
    "base": "main",
    "files_changed": 7,
    "elapsed_ms": 764000
  }
}
```
```

A failure:

```
🔴 task-implement / dev-loop-iteration-4
run 8a3f12bc · 2026-05-13T18:08:54Z · iteration 4/5

Test failure: 3 of 18 tests failing in convex/auth.test.ts
First failure: "magic-link sign-in flow creates a users row"
Expected status 200, got 401.

Artifacts: `~/.archon/workspaces/joshuarossi/Clarity/artifacts/runs/8a3f12bc/`

```json
{
  "level": "error",
  "workflow": "task-implement",
  "node": "dev-loop-iteration-4",
  "run_id": "8a3f12bc",
  "issue_key": "WOR-91",
  "fields": {
    "iteration": 4,
    "max_iterations": 5,
    "tests_total": 18,
    "tests_failing": 3,
    "first_failing_test": "magic-link sign-in flow creates a users row",
    "artifacts_dir": "/home/user/.archon/workspaces/joshuarossi/Clarity/artifacts/runs/8a3f12bc"
  }
}
```
```

A paused state:

```
⏸️ epic-decompose / final-comment
run b9c2dff3 · 2026-05-13T16:42:00Z · elapsed 4h12m08s

Epic decomposition complete. Created 59 tasks (WOR-89–WOR-147) with 228 Blocks links.

**PAUSED — operator checkpoint.** All tasks remain in Backlog with the
`archon-blocked-pending` label. Release work by removing the label from
one root task and transitioning it to Selected for Development.

```json
{
  "level": "paused",
  "workflow": "epic-decompose",
  "node": "final-comment",
  "run_id": "b9c2dff3",
  "issue_key": "WOR-88",
  "fields": {
    "tasks_created": 59,
    "first_key": "WOR-89",
    "last_key": "WOR-147",
    "blocks_links": 228,
    "elapsed_ms": 15128000,
    "paused": true
  }
}
```
```

---

## The header line

`{emoji} {workflow} / {node}`

| Emoji | Level | When |
|---|---|---|
| 🟢 | `info` | Routine success — state transition completed, PR opened, ticket created |
| 🟡 | `warn` | Soft failure or unusual state worth noting — retry succeeded, validation matched but barely, fallback used |
| 🔴 | `error` | Hard failure — test failure, transition rejected by Jira, PR merge blocked, validation failed |
| ⏸️ | `paused` | Awaiting operator action — `archon-blocked-pending` set, manual checkpoint, approval gate |
| 🧭 | `meta` | Routing / planning — router dispatched a workflow, plan attached, decision recorded |

The slug `{workflow} / {node}` is verbatim from the YAML — `task-implement` /
`open-pr`, `epic-decompose` / `process-tasks`, `task-done` / `unblock-sweep`,
etc. **Do not abbreviate, do not paraphrase.** The slug is the join key
between a comment and a log line.

---

## The metadata line

`run {short_run_id} · {iso_timestamp} · {optional metadata}`

- **short_run_id** is the first 8 chars of the workflow `run_id`. The
  full id lives in the JSON payload.
- **iso_timestamp** is `new Date().toISOString()` rendered without
  fractional seconds. Jira shows a timestamp too, but ours is set at
  comment-emit time inside Archie — Jira's is set at API-receive time
  and can drift.
- **optional metadata** is a single short fact useful in scan view:
  `elapsed 12m44s`, `iteration 4/5`, `attempt 2`, `cost $0.42`. Pick the
  most decision-relevant fact for the call site. Omit if none applies.

---

## The body

1–6 lines of markdown. Specific, not narrative. Sentence fragments are
fine. Bullets fine. Backticks for identifiers (`branch_name`,
`issue_key`, `file/path.ts`). **Bold** for the human-readable label of
the work item ("**T17 — TopNav component**"). Code fences for multi-line
errors, only when they add signal.

What goes here:
- The single most important fact (PR opened, test failed, plan complete).
- Identifiers and counts that let an operator decide whether to dig in.
- A pointer to artifacts/logs if any (absolute path, in `` `backticks` ``).

What does NOT go here:
- Narration ("I am now going to…", "Successfully posted…").
- Re-stating what the header already says.
- Multi-paragraph prose. The payload is for structured fields; the body
  is for the operator's eye.

---

## The payload

A fenced ```json``` block, one JSON object, this exact shape:

```json
{
  "level": "info" | "warn" | "error" | "paused" | "meta",
  "workflow": "<workflow-name>",
  "node": "<node-id>",
  "run_id": "<full run id, not truncated>",
  "issue_key": "<the ticket this comment is on>",
  "fields": {
    "<arbitrary structured payload, per call site>": "..."
  }
}
```

**Top-level keys are fixed.** `fields` is the open-ended bag — each
emitter defines what makes sense for its context. Suggestions:

- `pr_number`, `pr_url`, `branch`, `base`, `files_changed` (PR ops)
- `iteration`, `max_iterations`, `elapsed_ms`, `cost_usd` (loops)
- `tests_total`, `tests_failing`, `first_failing_test` (test runs)
- `tasks_created`, `first_key`, `last_key`, `blocks_links` (epic-decompose)
- `from_status`, `to_status`, `transitioned_by` (state transitions)
- `artifacts_dir`, `log_path` (when relevant)

The payload is for grep + future automation (a comment-roll-up
dashboard, anomaly detection, regression analysis). Keep field names
snake_case and stable across emit sites where the meaning is the same
(`elapsed_ms` not `elapsedMs`, `pr_url` not `prUrl` or `pull_request_url`).

---

## Anti-patterns

These are the failure shapes the current `console.log`-style comments
already exhibit. Do not reproduce them.

- **Marketing voice / narration.** ❌ "Successfully posted a comment on
  the new issue. The keymap has been updated and the comment was posted
  via the Jira API." ✅ "Created WOR-91 as T17."
- **Re-stating the obvious.** ❌ Header says "🟢 task-implement /
  open-pr", body says "The PR has been opened by task-implement."
- **Multi-paragraph prose.** ❌ A 12-line wall of text describing each
  step the agent took. ✅ The salient outcome + a pointer to the run.
- **Untagged origin.** ❌ A bare "Promoted to Selected for Development."
  ✅ The header tells you which workflow/node did it.
- **Mixed levels.** ❌ A 🟢 comment that includes a buried "the
  previous attempt failed" detail. Either it's an error (🔴 / 🟡), or
  the previous failure deserves its own comment.
- **Inconsistent field names across emitters.** ❌ One script writes
  `prNumber`, another writes `pr_number`, a third writes
  `pull_request_id`. ✅ Use snake_case + stable vocabulary.
- **Secrets / tokens / API keys in payload.** Never. Comments are
  permanent and indexed.

---

## How to migrate

Migrated emit sites (as of 2026-05-13):

- `.archon/scripts/jira-attach-plan.ts` — plan attached confirmation
- `.archon/scripts/jira-task-done.ts` — promote, epic-complete, done-summary
- `.archon/scripts/jira-transition-task-to-in-progress.ts` — test-gen → In Progress
- `.archon/scripts/task-transition-to-done.ts` — task complete → Done
- `.archon/scripts/task-open-pr.ts` — PR opened
- `.archon/scripts/task-merge-pr.ts` — PR merged
- `.archon/scripts/jira-epic-decompose-final-comment.ts` — paused checkpoint
- `.archon/workflows/defaults/epic-decompose.yaml` — `process-tasks`
  agent prompt: per-ticket creation comment, built inline by the
  agent following the same template

Removed as orphans (no callers after the pause-after-decompose change):

- `.archon/scripts/jira-final-comment.ts`
- `.archon/scripts/jira-unblock-roots.ts`
- `.archon/scripts/jira-unstick-rest.ts`

Runtime support:

- The DAG executor exports `WORKFLOW_NAME`, `NODE_ID`, and
  `WORKFLOW_RUN_ID` into every bash node's env. Scripts read these from
  `process.env` (the lib's defaults). No per-node `export` boilerplate
  needed in YAML.
- `jira-tool.js`'s `addComment` action now renders markdown to ADF via
  the existing `mdToAdf()` helper, so fenced code blocks (the JSON
  payload section) render as structured Jira `codeBlock` content rather
  than collapsing into a single paragraph. Callers can pass `text`,
  `textMarkdown`, or `textMarkdownFile`; all routes render as markdown.

When adding a new emit site, the playbook is:

1. Build the structured `fields` object.
2. In TS scripts: import `postWorkflowComment` from
   `.archon/scripts/lib/jira-comment.ts` and call it.
3. In agent prompts: emit the template literal inline. The header line,
   metadata line, body, and fenced JSON payload all follow the same
   shape.
