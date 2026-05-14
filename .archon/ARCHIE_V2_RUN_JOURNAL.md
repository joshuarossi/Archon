# Archie v2 Run Journal

A running record of the first end-to-end test of the v2 Archie pipeline
against the Clarity project (WOR-90). Time-ordered, in-flight notes —
what we did, what we observed, what we decided, what we deferred.

The structured backlog of code-level v2 work lives in
`ARCHIE_V2_BACKLOG.md` and `ARCHIE_V2_PR_PLAN.md`. This file is the
narrative companion: it captures *why* a decision was made when, what
the evidence was, and what surprised us.

**For agents picking up work cold:** read the most recent dated entry
first to orient on current state. Earlier entries provide the history
of decisions and rejected alternatives. When you find a wrong-turn
note or a "decided not to do X because Y" passage, take it seriously —
those are the lessons that already cost us time. Each entry should
end with where things stand at that moment; if you can't tell from the
last entry what state the system is in, the last entry's author owes
the next reader an update.

---

## 2026-05-13 — Mark4 plan evaluated against mark3 baseline

We compared the mark4 adversarial decomposition workflow against
mark3 on the same ConflictCoach v1 PRD/TechSpec/DesignDoc/StyleGuide
input. The mark4 changes (`dependency_completeness` rubric reframed
to focus on cycles / cross-cutting / Phase 0 gating; `adversarial-plan`
loop at `effort: high`; advisers at `effort: max`) produced concrete
improvements:

- Convergence in 4 rounds vs mark3's 8 (capped)
- Cost halved: $7.41 vs $14.21
- 59 single-surface tickets vs 48 multi-surface bundles
- NFR library 12 (granular: ai-perf, realtime-perf, dashboard-perf,
  privacy-ux, cost-budget, design...) vs 6 (coarse)
- The Login feature decomposed across 3-4 surface-aligned tickets
  rather than one multi-surface bundle (T11 mark3 was the canonical
  failure shape).

The load-bearing finding: **one surface per ticket** is the property
that makes autonomous execution tractable. Each implementing agent
reasons about one surface and honors one contract. We saved this as
a memory: `feedback_one_surface_per_ticket.md`.

Decision: promote mark4 to production by splicing its authoring chain
into `epic-decompose.yaml` in place of the legacy single-shot
`build-decomposition-plan-json` node. The Jira plumbing (per-task
ticket creation, blocks-link wiring, etc.) stays unchanged because
mark4's `plan-final.json` is a strict superset of the previous shape.

Done in PR #16 (`feat/epic-decompose-mark4`), merged.

Also rolled in upstream `git add -A` sweep fix from coleam00/Archon
PR #1506 — relevant because per-file staging matters for clean
commits. Done in PR #18 (`chore/sync-upstream-add-A-fix`), merged.

Next: write the comment-format spec.

---

## 2026-05-13 — Structured Jira-comment format

The state of Jira comments in Archie was console.log-style narration
scattered across ~10 emit sites: scripts, agent prompts, workflow
nodes. Reading a ticket's comment thread three weeks later was
impossible — no consistent "what / when / which workflow / which
node" framing.

Designed the spec: every comment is `{emoji} {workflow} / {node}`
header + run + ISO timestamp metadata line + short markdown body +
fenced JSON payload. Five levels (🟢 info, 🟡 warn, 🔴 error,
⏸️ paused, 🧭 meta).

Decisions made along the way:

- **Helper lib in TS, not just convention.** Wrote
  `.archon/scripts/lib/jira-comment.ts` exposing
  `postWorkflowComment()`. Twelve TS scripts call it; the two YAML
  emit sites build the same shape inline. Format change in one place
  if we want to tweak later.
- **Payload in fenced code block, not separate attachment.** Jira
  rendering for fenced JSON is acceptable. Attachments per comment
  would be noisy.
- **Markdown renders properly now.** `jira-tool.js` `addComment` was
  collapsing multi-line content to a single paragraph. Routed it
  through the existing `mdToAdf` helper so code blocks, lists,
  headings render as structured Jira `codeBlock` content.
- **Runtime exports `WORKFLOW_NAME` / `NODE_ID` / `WORKFLOW_RUN_ID`
  into every bash node's env.** Small dag-executor edit. Scripts read
  them from `process.env` without per-node `export` boilerplate.
- **Orphaned scripts deleted, not kept "just in case":**
  `jira-final-comment.ts`, `jira-unblock-roots.ts`,
  `jira-unstick-rest.ts`. They had no callers after the
  pause-after-decompose change.

Done in PR #19 (`feat/structured-jira-comments`), merged.

Also added the pause-after-decompose checkpoint to `epic-decompose`:
removed the legacy `unblock-roots` + `unstick-rest` nodes. Every
decomposed ticket retains `archon-blocked-pending`; the operator
manually releases the first ticket. The `jira-task-done` sweep
already respects this label, so no other nodes had to change.

---

## 2026-05-13 — Clarity Epic provisioned

Set up the test target. Renamed Conflict Coach → Clarity throughout
the PRD (which became the Epic description) and four attachments
(TechSpec, DesignDoc, STYLE_GUIDE.md, style-guide.html). Created
WOR-90 in Backlog with the renamed content.

Decisions:

- **Present Clarity as fresh, not as a rename.** Collapsed the PRD
  changelog and deleted the "Conflict Coach vs Conflict Resolution
  Arbiter" naming open-question. Reinforces the "structurally similar
  to a brand new project" goal.
- **Kept the in-product concept vocabulary** (Coach, Private Coach,
  Draft Coach, Case, Party, Initiator, Invitee). These describe the
  interaction model, not the brand.
- **Routing config changed.** `WOR: joshuarossi/ConflictCoach` →
  `WOR: joshuarossi/Clarity` in `~/.archon/config.yaml`. Server
  restarted to pick up the new map.
- **Env vars on the Clarity codebase**, mirroring what ConflictCoach
  had: `JIRA_BASE_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN`,
  `GH_TOKEN`. Set via the Settings UI.

Lesson surfaced: distinguish between **operator env-vars** (Archon's
DB — what Archie uses to talk to Jira/GitHub *about* the codebase)
and **deployment env-vars** (Convex's dashboard — what Clarity
itself uses at runtime). The decomposition plan didn't fully
distinguish these, and we had to do it manually as Phase 0 tickets
came up. Worth thinking about whether the test-gen brief for Phase 0
tickets should be explicit about which env layer.

---

## 2026-05-13 — Epic decomposition end-to-end, paused checkpoint reached

Transitioned WOR-90 Backlog → Selected for Development. The router
fired, but **the first attempt failed instantly** — the new clone of
joshuarossi/Clarity had no commits, no branches, so
`git rev-parse --abbrev-ref HEAD` for default branch detection
errored. Wrote a README, pushed an initial commit on `main`, set
remote HEAD, transitioned WOR-90 back to Backlog, re-fired.

Lesson: **the codebase must have at least one commit on `main`
before the pipeline can operate against it.** Empty GitHub repos
don't have a default branch at all. Worth a Mode-1 issue:
`task-tests` / `epic-decompose` could detect this and surface a
clearer error than "neither origin/HEAD nor origin/main exist."

Second attempt succeeded. The run took 2h 59m, cost $44.51, no node
failures.

What happened concretely:

- Adversarial-plan converged at round 3 (vs baseline mark4's 4
  rounds against the same input). Five round-1 objections, two
  round-2, zero round-3. Faster convergence than the baseline run
  even with the same prompt — confirming the loop is stable.
- 47 tickets created (vs baseline's 59 — 20% smaller). Different
  milestone granularity (5 vs 9). NFR library halved (6 vs 12).
  Comparable surface decomposition. Total estimate 28.8 hr vs 54.2
  hr. The variance is meaningful but reasonable; the loop is
  stochastic, not deterministic.
- 113 Blocks links wired.
- Final ⏸️ paused-checkpoint comment posted to WOR-90 with the new
  format. Verified ADF rendering: emoji + slug header, metadata
  line, body paragraphs, JSON `codeBlock` with all fields.

Per-ticket throughput is the one operational concern: the
`process-tasks` loop runs slower than baseline because the new
comment template adds 2-3 tool calls per ticket (read template,
compute ISO timestamp, write multi-line markdown body file). Total
loop time was ~2.5 hours for 47 tickets, ~3 min/ticket. Acceptable
for now; worth optimizing later. Logged as a Phase-2 follow-up.

Sample child ticket inspection — WOR-91 (Provision Convex), WOR-95
(schema), WOR-115 (InviteAcceptPage), WOR-130 (Closure UI) — all
correctly labeled `archon-blocked-pending`, correct Blocks links,
descriptions match plan content. The label invariant holds: all 47
children blocked, no auto-promotion. The pipeline is paused exactly
as designed.

Also noted: **on every Jira transition the router posts a "Starting
workflow: jira-router" comment** that bypasses the new structured
format. Comes from `executor.ts:713` and `command-handler.ts:873`
(workflow-runtime auto-startup messages). Worth a Phase-1.5
follow-up: add an `announce_start: false` flag at workflow level so
short-lived dispatchers (jira-router, task-done) don't spam.

---

## 2026-05-13 / 2026-05-14 — Phase 0 worked

Worked through all four human-only Phase 0 tickets:

- **WOR-91 Convex Cloud Project.** Created project (`polished-corgi-54`)
  in dashboard, captured `VITE_CONVEX_URL`. Stored it in both
  `.env.local` (Clarity repo, gitignored) and Archon's Clarity
  codebase env-vars. Manually transitioned to Done.
- **WOR-92 Anthropic API Key.** Found secrets reusable from the
  Conflict Coach repo. Set `ANTHROPIC_API_KEY` (and several adjacent
  vars: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`,
  `RESEND_API_KEY`, `MAGIC_LINK_EMAIL_FROM`) in Convex via
  `npx convex env set` from `/home/user/Clarity`. Marked Done.
- **WOR-93 Google OAuth.** Already covered by the env-set above.
  Marked Done.
- **WOR-94 GitHub repo + CI.** Set `CONVEX_DEPLOY_KEY` (production
  deploy key) as a repo secret. Skipped `ANTHROPIC_API_KEY` as a
  repo secret because CI E2E uses `CLAUDE_MOCK=true` — never makes
  real calls — making the key dead weight in GH. Skipped branch
  protection requiring review because it conflicts with Archie's
  autonomous merge. Wrote `.github/workflows/ci.yml` placeholder
  (four-stage lint/typecheck/unit/E2E pipeline that no-ops cleanly
  if scripts don't exist yet). First run green in 12 seconds.

Lessons:

- **Operator env vs deployment env.** Worth being explicit in
  Phase 0 ticket descriptions about which layer. We had to figure
  it out by inspection: Convex needs the Anthropic key (server-side
  for Convex actions), GH Actions does NOT (CI uses mocks).
- **The Conflict Coach repo was a useful reference.** We had a
  past project with all the same env vars already provisioned. Saved
  significant time. Future projects without that history will need
  to provision from scratch.
- **Local-repo clone vs Archon-managed clone divergence.** When
  Josh's `/home/user/Clarity` clone and Archon's
  `/home/user/.archon/workspaces/.../source` clone diverged (Josh
  ran `npx convex dev` in the user clone, scaffolding `convex/`
  there), the resolution was "push to origin, Archon worktrees from
  origin fresh per task-implement." No need to manually sync the
  Archon-managed clone.
- **Git remote credentials.** The user clone had no embedded token
  in its remote URL, and `gh`'s default fine-grained PAT couldn't
  push. Embedded the classic `ghp_...` PAT (the one Archon uses) into
  the user clone's remote URL. Pragmatic; not ideal long-term.

Pipeline is now at the **real** paused-checkpoint state: all four
human Phase 0 tickets Done, no auto-promotion fired (label held), 5
tickets are now true roots (no remaining inward Blocks): WOR-95
schema, WOR-100 privacy filter, WOR-101 transcript compression,
WOR-103 theme/style, WOR-107 Playwright infra.

---

## 2026-05-14 — First autonomous ticket: WOR-95 (Convex schema)

Chose WOR-95 as the first autonomous run. Reasoning: smallest
surface area (one file, declarative), no external API calls, maximum
downstream unblocking (many tickets depend on the schema), easy to
eyeball-review.

Stripped the `archon-blocked-pending` label, transitioned WOR-95 to
Selected for Development. The router fired `task-tests`. Watched it
through.

### Phase 1: task-tests completed cleanly

Twenty-some nodes, no failures, ~30 minutes:

- prepare-branch created `archon/task-wor-95` off origin/main
- create-contract wrote `docs/contracts/wor-95.md` (machine-readable
  spec: 11 tables, exact field names, indexes, status union, literal
  validators, etc — derived from TechSpec §3.1)
- generate-tests wrote two test files (380-line runtime + 69-line
  typecheck) and scaffolding (`vitest.config.ts`,
  `eslint.config.js`, `tsconfig.json`, `package.json` scripts)
- review-1 flagged 7 missing field-presence assertions
- repair → review-2 passed clean
- validate-1 reported `lint: passed, typecheck: passed`
- commit-and-push committed contract + tests + `package.json` +
  `package-lock.json` + `vitest.config.ts` to the branch
- transition-to-in-progress fired

Sailed through. Looked great.

### Phase 2: task-implement converged on first attempt

- dev-attempt-1 wrote `convex/schema.ts` with all 11 tables.
  Committed as `feat(WOR-95): add Convex schema definition with all
  11 tables`.
- test-1 + validate-1 passed first try.
- implementation-quality-final approved.
- generate-docs + open-pr → PR #1 opened on joshuarossi/Clarity.

### Phase 3: PR reviewer DAG, synthesizer, auto-fix — and the stuck state

Five parallel reviewers critiqued the PR. Synthesizer rolled up 10
findings: 3 marked as actionable (HIGH: `package.json` name was
`task-wor-95` instead of `clarity`; MEDIUM: typecheck script needs
`tsconfig.json`; LOW: stale `@ts-expect-error` directive in
schema.test.ts), 7 marked "keep as-is" style notes. Verdict:
`changes_requested`.

implement-fixes applied 2 of 3. The third — stale `@ts-expect-error`
in a test file — was deferred per the file-protection hook policy
(implementation can't edit tests).

post-fix-validation ran 5 gates:

- `obsolete-ts-expect-error-cleanup` gate: **stripped the stale
  `@ts-expect-error` directive from `tests/wor-95/schema.test.ts`**.
  Committed the cleanup.
- `lint`: failed — "ESLint couldn't find an eslint.config.js file."
  Marked non-blocking.
- **`typecheck`: failed** — TS7053 errors on
  `schema.tables[tableName]` dynamic indexing (lines 8 and 19 of
  the test file). Marked blocking.
- `vitest`: passed 135/135.
- `playwright`: skipped.

Overall: failed. The DAG cascade-skipped `merge-pr`,
`transition-to-done` per their `when:` conditions. Workflow
"completed" without merging. PR stayed open, WOR-95 stayed In
Progress. **First stuck state.**

### Diagnosis

After reading the artifacts in order (contract.md, test files at
each branch commit, test-review JSON, validation logs), here's what
happened:

The test-gen agent wrote `// @ts-expect-error WOR-95 red-state
import: ...` at the top of `schema.test.ts`, suppressing the
`import schema from "../../convex/schema"` line. At red state the
schema file didn't exist; the directive was correct. The reviewer
explicitly endorsed it as "task-labeled @ts-expect-error for
red-state correctness."

But the suppression also masked the *body* of the file: the test
code does `schema.tables[tableName]` (dynamic string indexing). With
the import suppressed, `schema` was effectively `unknown`-typed, so
the indexing typechecked. After task-implement created the real
`convex/schema.ts`, the import succeeded — the directive became
"stale" in the strict-mode sense — but the directive was still
*suppressing the rest of the file's type errors*. The
`obsolete-ts-expect-error-cleanup` gate then removed the now-stale
directive, exposing the type errors that had been hidden the whole
time.

**Conclusion:** the bug isn't the cleanup gate. The cleanup gate did
its job, found the genuinely-stale directive, removed it. The bug
is at test-gen time: **a file-scope `@ts-expect-error` is the wrong
tool for "I'm referencing code that doesn't exist yet."** It hides
both the legitimate red-state error and any unrelated type bugs in
the same file. The reviewer endorsed the pattern because the prompt
told it to.

### Decision: fix the test-gen validator, not the cleanup gate

We had a long discussion about the philosophy. The right framing
turned out to be:

- TDD: write tests first, freeze them through implementation. The
  cage forbids implementation from editing tests.
- This means tests must be **valid and complete at red state** —
  they will fail at red (no code yet), pass at green (after
  implementation). They never get modified.
- So we can't blindly require `tsc --noEmit` to pass on the test
  files at red state — they reference code that doesn't exist.
- But we also can't allow blanket suppressions (`@ts-expect-error`,
  `any`, `@ts-ignore`, etc.) — those hide real bugs in test code.
- The right discipline: **forbid suppressions entirely, and make the
  validator distinguish expected red-state errors (`TS2307` on
  paths the contract promises will be created) from unexpected ones
  (everything else, which is a real test-code defect).**

The bug is upstream slop, not the cleanup gate. Fix the test-gen
side.

Things we considered and rejected:

- **Type-only declare in test files** (use `declare module` to give
  the not-yet-existing import a shape derived from the contract).
  Cleaner typechecking but adds machinery that only exists to
  satisfy the typechecker. Tests should look like normal tests.
- **Restructure task-tests as an adversarial loop** (mark4-style:
  one node, one prompt, phase-branched, exit on convergence). Two
  blockers: (1) loops can't use hooks currently, and the cage in
  task-implement IS a hook — we'd lose cage compatibility for
  consistency in only one workflow. (2) the existing DAG is already
  conditional ("review-2 only fires if review-1 failed"), not a
  fixed 2-round count. The structural improvement isn't free and
  isn't urgent.

Things we filed for later:

- **Phase-2 follow-up: optimize per-iteration cost in
  `process-tasks`.** The new comment template adds ~2 min/ticket.
- **Phase-1.5 follow-up: suppress runtime auto-start comments for
  short-lived dispatchers** (jira-router, task-done). Add
  `announce_start: false` flag at workflow level.
- **Engine limitation: loops can't use hooks.** Mode-1 issue. Logged
  as a v3 candidate for when we want to restructure
  task-tests/task-implement into adversarial-loop shape.
- **Test-gen scaffolding consistency.** The agent created
  `eslint.config.js` and `tsconfig.json` in the working tree but
  the `commit-and-push` step only staged a fixed list of 6 files —
  scaffolding got dropped. Result: branch had a `package.json` with
  `lint` and `typecheck` scripts referencing files that didn't
  exist on the branch. Considered fixing this directly, but
  realized: if we fix the validator (the real bug), the scaffolding
  drop becomes detectable via the validator's lint failure. Leaving
  it for now; revisit if it surfaces again.

### Reset

Closed PR #1, deleted `archon/task-wor-95` branch (origin + local),
removed the worktree, transitioned WOR-95 back to Backlog,
re-applied `archon-blocked-pending` label. Preserved all artifacts
under `~/.archon/workspaces/joshuarossi/Clarity/artifacts/runs/`
for diagnosis. Clean state.

### Three changes in flight

1. **Update `archon-review-generated-tests.md` prompt** — replace
   the `@ts-expect-error` endorsement with a hard-fail rule: no
   escape hatches (`@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`,
   explicit `any`, `as any`, `as unknown`) in any test file, period.
   The reviewer flags any occurrence as an automatic
   `required_repair`.

2. **Rewrite `validate-generated-tests-1` / `-2`** — replace the
   binary `npm run typecheck` pass/fail with a contract-aware
   validator. Run `tsc --noEmit`, parse errors, classify each:
   - Expected: `TS2307 Cannot find module 'X'` where X resolves to
     a path the contract promises will be created. These are
     tolerated.
   - Unexpected: everything else. Hard fail.
   Also scan all test files for escape-hatch patterns and hard-fail
   on any match. Extracted to a standalone TypeScript script
   (`test-gen-validate.ts`) rather than embedded bash for clarity.

3. **Remove the `obsolete-ts-expect-error-cleanup` gate** from
   `task-implement`'s post-fix-validation. With (1) in place, no
   directives exist for the gate to clean. Removing it eliminates
   the footgun that landed us here.

(Status as of this write: Step 1 done, Step 2 done, Step 3 next.)

### Wrong turns I (the agent) took during this diagnosis

Worth preserving in the journal because they're the kind of thing
that's easy to repeat:

- **Invented a "transition back to Backlog on validation failure"
  feature.** Wrote a long finding about how the DAG "should have
  fired `fail-implementation-not-ready` to surface the broken state
  via a Backlog transition." Josh corrected: there is no such
  feature. The only case Archie pushes a ticket back to Backlog is
  the `bug-pipeline` grooming-rejection path, not a general failure
  recovery. The intended behavior on validation failure is exactly
  what happened: PR stays open, ticket stays In Progress, system
  declines to merge a broken PR, human decides what to do. The
  "stuck state" framing was projection.
- **Proposed switching `task-tests` to the adversarial-loop pattern
  for elegance.** Josh corrected: loops can't use hooks, and the
  cage in `task-implement` IS a hook. Inconsistent structural
  patterns across the SDLC pipeline cost more than the elegance
  saves. The current explicit DAG is the right shape.
- **Called the existing test-gen DAG "hard-coded 2 rounds, always
  runs both even if first passes."** Josh corrected: read the YAML
  again. `repair-tests-from-review` and `review-generated-tests-2`
  have `when:` conditions gating on
  `$parse-test-review-1.output.passed == 'false'`. The DAG is
  already conditional; a clean first review skips both repair and
  re-review nodes entirely. I had read the node names as a fixed
  sequence and missed the gates.

The pattern across these mistakes: **I reach for elegant structural
explanations when the existing code is fine, and propose
restructuring it.** Easier to read the code carefully first and
trust that it might already be doing the right thing.

---

*Time-stamped from here. Thursday, May 14 2026 · 1:32 AM CDT.*

---

## Thursday, May 14 2026 · 1:35 AM CDT — Three TS-validator changes landed

All three changes are in:

1. **Reviewer prompt** (`archon-review-generated-tests.md`):
   - Added rule (e) under Phase 1.5: TypeScript escape hatches are
     an automatic hard fail. Six patterns enumerated:
     `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`, explicit `any`,
     `as any`, `as unknown`.
   - Rewrote the `__stubs__` paragraph: stop endorsing
     `@ts-expect-error` as the red-state pattern. The validator now
     accepts unsuppressed imports because it can classify expected
     red-state errors against the contract.
   - Updated Phase 2 evaluator: ask the reviewer to verify escape
     hatches are absent and that imports target contracted paths
     directly without suppression.
   - Updated PHASE_1.5_CHECKPOINT with a new line item.

2. **Validator** (new file
   `.archon/scripts/test-gen-validate.ts`, ~270 lines):
   - Scans every test file under `tests/`, `src/`, `e2e/` for the
     six escape-hatch patterns. Each hit is recorded with
     `file:line:col`, pattern name, and the offending line text.
   - Reads `$ARTIFACTS_DIR/contract.md`, parses `files[].path`
     entries.
   - Runs `npm run lint` and `npm run typecheck`. Captures full
     output to log files.
   - Parses tsc output into structured errors (`file:line:col code
     message`). Classifies each error as expected (TS2307 on a
     contract-promised path) or unexpected (everything else).
   - Writes structured detail to
     `test-gen-validate-report.json` plus a single-line stdout JSON
     for the workflow runtime.
   - Pass condition: zero escape hatches AND zero unexpected
     typecheck errors AND lint not failed.
   - YAML nodes `validate-generated-tests-1` and `-2` now just call
     this script instead of running inline bash.

3. **Cleanup gate removal**
   (`.archon/scripts/task-run-validation.sh`):
   - Stripped the `obsolete-ts-expect-error-cleanup` gate.
   - Replaced with a long comment explaining why it was removed and
     pointing at this journal.
   - Deleted the orphaned
     `task-cleanup-obsolete-ts-expect-error.ts` script.
   - Updated `ARCHIE_PIPELINE.md`'s script inventory.

Synthetic test confirmed the new validator catches the WOR-95 issue
shape: created a test file with `@ts-expect-error`, `: any`, and
`as unknown`, ran the validator with `ARTIFACTS_DIR` pointing at a
contract that names `not-yet-exists.ts`. Result: `passed: false`,
`escape_hatches_found: 3`, each correctly identified with file:line
and pattern name. Exactly what we want.

Full `bun run validate` running now. If it's green, this is the
moment to commit and PR.


