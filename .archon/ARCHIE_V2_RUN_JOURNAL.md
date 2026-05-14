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

`bun run validate` came back green. Committed as
`feat(test-gen): contract-aware validator forbids TS escape hatches`,
pushed as branch `feat/contract-aware-test-gen-validator`, opened
PR #20.

---

## Thursday, May 14 2026 · 1:38 AM CDT — Guiding principles, said out loud

Two framing ideas Josh articulated that are worth preserving here as
durable principles for the remainder of the v2 test:

**1. The goal isn't to produce code; the goal is to prove the system
operates without intervention.**

The first WOR-95 run produced a correct Convex schema (11 tables,
all fields, 135/135 tests passing). By the "did we get code"
standard, it succeeded. But the pipeline got stuck after the dev
loop — PR open, ticket In Progress, workflow ended without merging.
We resolved it by hand. **That makes the run a failure regardless
of code quality.** The standard isn't "did Archie write good code
this time" — it's "can a future project go from Epic → Done with
zero operator intervention." The schema is incidental; the
hands-off success is the actual deliverable.

This is the same logic as "test fixes by re-running the failing
test, not by reasoning that it should now pass." Watching the
system work correctly is the only evidence the system works
correctly. Re-firing WOR-95 from scratch (after merging PR #20) is
the only way to prove the validator fix actually unblocks the
pipeline — not a proof we can construct on paper.

**2. One ticket at a time, deliberately, because we're validating
the automation — not chasing output.**

We don't care about throughput. We care about whether the
automation actually works. If we unblocked all five root tickets at
once and three of them stuck for three different reasons, we'd
have a tangled multi-failure to debug instead of three clean
attributable signals. **Each ticket is its own controlled
experiment.** Single-stepping is what lets us cleanly attribute
"this fix unblocked WOR-95" or "this new failure mode appeared at
WOR-100" or "the pipeline ran hands-off through WOR-X."

The PROMOTE_CAP=1 in `jira-task-done.ts` is the system-level
enforcement: even unattended, exactly one newly-unblocked ticket
gets promoted per Done event. But during validation we go further:
keep the `archon-blocked-pending` label on every non-current
ticket so the sweep finds zero candidates, and manually release the
single ticket we're studying.

We relax this only once we've watched the pipeline succeed
end-to-end without intervention on enough tickets to characterize
the failure modes. Until then, single-stepping is the discipline.

**3. Prefer "halt cleanly when uncertain" over "merge anyway."**

The pipeline has two failure modes:

- **Stuck-but-correct.** A validator catches a real problem, the
  workflow halts, the PR stays open. The operator can inspect,
  diagnose, fix the root cause.
- **Unstuck-but-wrong.** A validator misses a problem, the workflow
  merges a PR it shouldn't have. We get throughput at the cost of
  correctness.

The first WOR-95 run was actually mode (1): the post-fix-validation
typecheck refused to merge code with real type errors. The system
was doing exactly the right thing. We rescued it manually because
we wanted to *understand* the failure, but if we'd left it alone,
it was already correct in its refusal.

**Mode (1) is acceptable forever. Mode (2) is never acceptable.**

Concretely:

- A stuck ticket waiting for an operator: fine. The operator looks
  at it, sees what halted, decides. No harm done.
- A merged PR with bad code: not fine. The badness has now landed
  on main, possibly broken downstream tickets that build on it,
  and is harder to unwind than the alternative.

So bias the system toward strictness. The validators we built —
the test-gen escape-hatch scanner, the contract-aware typecheck
classifier, the merge-pr `when:` conditions, the file-protection
hook during implementation — should be **slightly too strict**
rather than slightly too loose. If they reject too often, the
agents have to write better code. That's a learning loop, not a
bug. If they ever fail to reject something they should have, the
cost is much higher than a few extra stuck tickets along the way.

The autonomous-throughput goal is *aspirational*, not the current
bar. Until the pipeline is trusted, "halts correctly when
something's wrong" is the bar we're optimizing for.

---

## Thursday, May 14 2026 · 1:49 AM CDT — `task-tests` could be an adversarial loop; `task-implement` can't

Reconsidering the loop-vs-DAG tradeoff with a correction.

The cage **only applies during `task-implement`**, where the dev
agent must not edit the tests (otherwise the perverse "delete the
test to make it pass" incentive kicks in). During `task-tests`,
the agent IS the test author and IS supposed to mutate the tests
as it generates and repairs them. **No cage needed in `task-tests`.**

That changes the structural picture. The "loops can't use hooks"
limitation only blocks adversarial-loop refactor of
`task-implement`. **For `task-tests`, we could legitimately switch
to a single adversarial-loop node right now** with `max_iterations:
10` (or however many is right), and we'd get:

- One node, one prompt, role-branched on phase (generate / review /
  repair / validate).
- Iterate until convergence or cap. No more 2-round ceiling.
- Cleaner DAG: `prepare-branch → adversarial-test-gen → commit-and-push → transition-to-in-progress`.

The blockers for `task-implement` remain — cage is a hook, loop
primitive doesn't support hooks, ergo task-implement stays as the
explicit 5-attempt DAG until the engine grows hook-in-loop support.

Worth holding off on the `task-tests` refactor until we've seen
this WOR-95 run play out under the existing DAG. If the new
contract-aware validator converges in 1 round (as expected for a
clean ticket), the cap doesn't matter and the refactor is
optimization-without-evidence. If the validator surfaces something
the current 2-round repair flow can't handle, that's the
motivation to do the loop refactor next.

The original `(1)+(2)+(3)` framing still holds for `task-implement`,
where lifting the engine limitation is the only path to clean.
Logged as a v3 engine candidate.

---

## Thursday, May 14 2026 · 1:50 AM CDT — The pipeline is generic; project-specific concerns live in the spec

Important correction to an earlier framing. I had started writing a
"beta-functional vs production-perfect" rubric table with rows like
"no cross-party data leakage — required" — putting Clarity-specific
invariants into the generic reviewer rubric.

**This is a structural error.** The Archie pipeline is the
SDLC engine. It runs against *any* project. It must never reference
"Clarity," or "privacy," or "subscriptions," or anything specific
to a particular product. The reviewer rubric in
`archon-review-generated-tests.md` and the validators in
`task-implement` are generic SDLC discipline:

- Does each AC have meaningful coverage?
- Are assertions strong enough to drive implementation honestly?
- Are tests written to fail for missing product behavior, not for
  malformed test code?
- Are there gaming patterns the implementer could exploit?
- Are tests realistic (using real harnesses where available, not
  mocking the runtime)?

The project-specific concerns flow in through a different path:

1. Project authors a PRD / TechSpec / DesignDoc and attaches them
   to the Epic.
2. `epic-decompose` reads the spec, produces a plan with
   surface-aligned tickets that carry the spec's invariants as
   acceptance criteria. ("Coach AI never quotes the other party's
   raw private input" is an AC on the relevant ticket, derived
   from TechSpec §6.)
3. `task-tests` reads the per-ticket ACs and authors tests that
   *enforce* those invariants — for example, a test that calls
   the Coach with private content and asserts the output doesn't
   contain a verbatim string from the other party.
4. `task-implement` writes code that makes those tests pass.
5. `task-merge-pr` won't merge a PR whose tests don't all pass.

**The privacy invariant gets enforced at the test-runner level, not
at the reviewer-rubric level.** The pipeline doesn't need to know
what privacy means for Clarity. It just needs to faithfully
execute the spec → AC → test → implementation chain. Each project
gets its own discipline by virtue of its own spec.

So the calibration question is **about generic SDLC quality**, not
about project-specific invariants:

- How strict should the reviewer be about test coverage of edge
  cases vs only happy paths? (Beta: happy paths + the two or three
  most-likely-to-break edge cases. Production: every edge case.)
- How strict about comment quality, naming, doc completeness?
  (Beta: minimal. Production: high.)
- How strict about polish-level findings (empty/loading/error
  states implementation, copy quality)? (Beta: not enforced.
  Production: enforced.)
- How aggressive about flagging "this could be more idiomatic"?
  (Beta: don't flag. Production: maybe flag as suggestions, not
  required_repair.)

These are tuning knobs on the generic rubric, and they apply the
same way whether the downstream project is Clarity or a
hypothetical SaaS or a CLI tool. The right framing: **the rubric
should care about engineering quality at a beta-appropriate
level, while the spec carries every project-specific invariant
through to the tests.**

Implication for Principle 3 ("halt cleanly when uncertain"): the
"correctness" being protected is *spec-derived correctness*
(ACs failing, contracts violated, tests broken), not generic
"engineering perfection." A pipeline that halts because a test
fails is doing the right thing. A pipeline that halts because the
reviewer thinks a variable name could be clearer is being too
precious for the bar.

---

## Thursday, May 14 2026 · 1:57 AM CDT — Second WOR-95 run halted at the validator gate (system working correctly)

The second autonomous WOR-95 run kicked off after PR #20 merged.
`task-tests` ran through:

- Setup nodes ✓
- create-contract → verify-contract-exists ✓
- generate-tests ✓ — but agent wrote `// @ts-expect-error` at the
  top of `schema.test.ts` (twice this time — once for the schema
  import, once for the dataModel types import). **Same habit as the
  first run.**
- review-1 → repair → review-2 → parse-final ✓
- validate-generated-tests-1: **failed** —
  `test-gen-validate-report.json` reports
  `escape_hatches_found: 2`, both `@ts-expect-error` on lines 2
  and 4 of `schema.test.ts`. Validator correctly refused to pass.
- repair-generated-tests → validate-generated-tests-2: presumably
  still failed (the agent didn't remove the hatches in the repair
  pass either).
- verify-tests-exist: failed → halted the workflow.

WOR-95 status: still **Selected for Development**. No
task-implement dispatched. **Pipeline correctly halted at the
gate.** Principle 3 in action: stuck-but-correct, not
unstuck-but-wrong.

This is the system working exactly as designed.

### What needs fixing

Two failures, layered:

**(a) The test-gen agent keeps writing `@ts-expect-error`.**
This is its trained habit. The prompt change in PR #20 told it
"don't" but the trained tendency is strong. A prompt change alone
isn't a hard guardrail — the agent will revert to the pattern when
under pressure (red-state import errors look scary; suppression
looks like the obvious fix).

**(b) The test-reviewer is not actually checking.**
This is the worse failure. The reviewer's summary text literally
says "No TypeScript escape hatches, no stub files, no selector
conflicts." But the file has two `@ts-expect-error` directives on
lines 2 and 4 — visible to anyone who reads the file. The
reviewer hallucinated a verification it didn't perform.

Why did the reviewer get away with this? Look at the review JSON
shape:

  passed, summary, coverage_gaps, weak_tests, lint_typecheck_risks,
  gaming_risks, selector_conflicts, unflushed_timer_tests,
  required_repairs

`selector_conflicts` and `unflushed_timer_tests` are
**structured-evidence arrays** the reviewer must populate with
specific file:line:rationale entries if hits exist. The Phase 1.5
prompt has dedicated checks for those.

There is **no structured-evidence array for escape hatches.** The
new rule landed as a checkbox in the PHASE_1.5_CHECKPOINT and a
bullet in the Phase 2 evaluator — but **the agent's output schema
doesn't have a field where it has to report each hit.** With no
structured field to populate, the agent just doesn't check. It
asserts "no escape hatches" in the prose summary because that
sounds like the right thing to say.

**The fix:** add a `typescript_escape_hatches: []` field to the
required output schema. The reviewer must populate it with
`{file, line, pattern, text}` entries for every hit found, same
shape as `selector_conflicts`. The prompt must require this — and
require the reviewer to grep the test files for the six patterns
explicitly, with the regex strings written into the prompt so the
agent can't just eyeball.

Then the reviewer will catch (a) before the validator does. Today
the validator is the safety net, and it caught the slip
correctly — but every safety net catch is a sign of an earlier
gate that should have caught it.

### Decision

Make two more prompt-level changes to `archon-review-generated-tests.md`:

1. Add `typescript_escape_hatches: []` to the required output
   shape, with the same structured-evidence convention as
   `selector_conflicts` (each entry: file, line, pattern, text).
2. Add an explicit Phase 1.5 sub-check that runs the regex grep
   for the six patterns over every test file, with the regexes
   written into the prompt. The reviewer can't claim "no hatches"
   without populating that field.

Also worth doing: **strengthen the test-gen prompt** to make it
say "don't write `@ts-expect-error` — the validator accepts
TS2307 on contract-promised paths as expected red-state errors,
so unsuppressed imports are correct." The agent's habit comes from
treating import errors as "scary" — explicit prompt language that
the imports are fine should reduce the urge.

For now: leave WOR-95 in its halted state. Don't rescue it. Make
the prompt changes, then re-fire from clean.

---

## Thursday, May 14 2026 · 2:08 AM CDT — The bigger mistake: I had only fixed the reviewer

While drafting the fix to the reviewer prompt, Josh pointed out
that I'd missed the most important thing: **the test-gen prompt
itself was actively instructing the agent to use `@ts-expect-error`.**
PR #20 only updated the reviewer; the generator prompt still said
verbatim "place a narrow `@ts-expect-error` directly above that
import" with code examples. The agent was just doing what its
prompt told it to.

This was a worse error than the missing structured-evidence field
in the reviewer. The reviewer is the *safety net* — the generator
is where the behavior comes from. Fixing only the safety net while
leaving the source unchanged is amplifying our own failure mode:
the agent will keep emitting suppressions, the reviewer keeps
catching them (eventually, when it's properly structured), and the
validator keeps rejecting. We're paying the cost of the loop on
every run.

Going through all four test-related prompts to find every place
that endorses the patterns:

- `archon-generate-tests.md` — five places explicitly told the
  agent to write `@ts-expect-error` directives.
- `archon-review-generated-tests.md` — already partially updated
  in PR #20, but needed the structured-evidence field.
- `archon-repair-tests-from-review.md` — one place told the
  reviewer-driven repair agent to use `@ts-expect-error`.
- `archon-repair-generated-tests-quality.md` — five places
  instructed the validator-driven repair agent to use suppressions
  to "make tsc pass."

All four prompts had to be rewritten coherently. The framing shift
that closed the loop: **`tsc --noEmit` is NOT expected to pass at
red state**, because the contract-promised modules don't exist
yet. The whole "make tsc pass" instruction was creating tension
that the agent resolved by reaching for suppressions. Once you
remove the requirement that tsc pass, you remove the pressure to
suppress.

The new uniform discipline across all four prompts:

- Lint must pass.
- `tsc` is **not expected to pass** at red state. The only
  acceptable tsc errors are `TS2307 "Cannot find module"` on paths
  the contract promises will be created.
- Any other tsc error is a real test-code bug; fix the test code,
  don't suppress.
- **Never** use `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`,
  `: any`, `any[]`, `as any`, `as unknown` — absolute hard-fails
  enforced by both reviewer (structured-evidence array) and
  validator (mechanical grep).

The atomic checkpoint items every prompt now has, in its relevant
phase, are exactly two lines:

```
- [ ] No TypeScript suppressions in any test file
      (@ts-expect-error, @ts-ignore, @ts-nocheck, : any, any[],
      as any, as unknown)
- [ ] Valid TypeScript everywhere else. The only acceptable tsc
      errors are TS2307 on contract-promised paths.
```

Terse, specific, verifiable. Each prompt's body has the reasoning;
the checklist is the binding contract.

### Meta lesson

When tracking down a failure mode, **find every place in the
pipeline that touches the broken pattern, not just the most
visible one.** I had focused on the reviewer because it's where
the WOR-95 stuck-state surfaced. Should have asked: "what wrote
the directives?" The answer was: the generator was told to. Same
mistake I had made earlier (skipping the test-gen scaffolding miss
because it would be detected via validator failure) — fixing the
downstream catcher while leaving the upstream emitter alone.

Adding to the wrong-turns list at the end of the WOR-95 diagnosis
entry as it becomes a pattern:

> **"Fix the visible downstream symptom, leave the upstream cause
> in place."** Twice now I've done this in this run. First with
> the test-gen scaffolding miss (eslint.config.js not committed —
> "the validator will catch it"). Second with the
> `@ts-expect-error` issue (only updated the reviewer, left the
> generator instructing the bad pattern). The pattern: fixing
> something close to where I noticed the failure feels like
> progress, but if I haven't fixed where the failure *originated*,
> the system will keep producing the same shape of failure.
>
> The discipline: when I see a failure, trace it backward to the
> first prompt / script / node that *generated* the offending
> output, and fix it there. Downstream gates are safety nets;
> they're not where the fix belongs.

### State right now

- All four test-related prompts rewritten with consistent
  no-suppressions / no-tsc-pass-required framing.
- Atomic two-line checkpoints in each prompt's relevant phase.
- New `typescript_escape_hatches` structured-evidence field in
  the reviewer's output schema.
- Validator (test-gen-validate.ts from PR #20) remains the
  mechanical backstop; no changes needed there.
- `bun run validate` green. `check:bundled` confirms bundled is
  up to date.
- WOR-95 is still in Selected for Development on the failed
  workflow run. Will need to be reset to Backlog + relabeled
  before re-firing after this PR merges.

About to commit and PR.

---

## State at this checkpoint

- **PR #20 open**, awaiting merge. Contains the three TS-validator
  fixes plus this journal.
- **WOR-95 is in Backlog** with `archon-blocked-pending` re-applied.
  All other 46 child tickets still labeled and untouched.
- **All 4 Phase 0 tickets** Done; their outward Blocks links cleaned.
- **The `archon/task-wor-95` branch** and **PR #1 on Clarity** are
  deleted/closed.
- **Worktree under `~/.archon/workspaces/joshuarossi/Clarity/worktrees/archon/task-wor-95`**
  removed.
- **Artifact runs preserved** under
  `~/.archon/workspaces/joshuarossi/Clarity/artifacts/runs/`
  (the full set: `epic-decompose` 556202f7, `task-tests` 5f143db2,
  `task-implement` 70a38cc1). Useful for diagnosis if needed.

After PR #20 merges: pull main, delete the local branch, strip the
label from WOR-95, transition WOR-95 → SfD, and watch the full
chain run hands-off.

---

## Thursday, May 14 2026 · 3:00 AM CDT — Plumbing bugs from the third run, and the contract I was getting wrong

The third WOR-95 run (`557cd9cc`) proved the prompt fixes from
PR #21 worked. Test-gen produced tests with **zero
`@ts-expect-error` directives**. The new validator approved them
cleanly (`passed: true`, `escape_hatches_found: 0`, the only tsc
error was `TS2307` on the contract-promised `convex/schema.ts`,
correctly classified as expected red-state). The reviewer
approved them with `typescript_escape_hatches: []`.

Then the run failed anyway, at `verify-tests-exist`, because of
three plumbing bugs orthogonal to the prompt work. Worth
recording both the bugs and **the larger framing I had wrong**
about how bash nodes communicate.

### What I got wrong: the bash-node output contract

I drifted into a "stderr/stdout Unix discipline" framing — fix
narration vs structured-data by routing them to different
streams. That's a real principle but it's not the **Archon
contract** for bash nodes. Re-read the docs
(`guides/authoring-workflows.md`):

- A bash node's **stdout is captured as `$nodeId.output`** —
  trimmed, then either returned whole or `JSON.parse`d when
  downstream `when:` clauses access `.field`.
- Bash nodes don't have `output_format` (that's for AI nodes).
- So **a bash node that wants to be queryable by `when:` must
  emit clean JSON on stdout**, no narration mixed in.

But that's only the **state channel.** Bash nodes also commonly
need to produce **information artifacts** (reports, plans,
files) — and those go via `writeFile` to `$ARTIFACTS_DIR/...`,
not via stdout redirection by the YAML.

Two distinct channels, two distinct mechanisms:

| Channel | Mechanism | When to use |
|---|---|---|
| **state** | print clean JSON to stdout | when downstream `when:` or `$node.output.field` substitution needs the value |
| **information** | `writeFile` to `$ARTIFACTS_DIR/<name>.json` | when downstream nodes read the file directly by known path (reports, contracts, plans, attachments) |

Both can coexist in the same script: write a full report to
ARTIFACTS_DIR (information), then emit a small JSON status object
to stdout (state).

The legacy pattern I was working around — script prints narration
+ JSON to stdout, YAML uses `> tmp.json && tail -1` to extract
the JSON — was wrong on both sides. The script should have
`writeFile`d its report directly; stdout should have been just
the state JSON. The `tail -1` shim was a symptom of having
collapsed two different communication channels into one stream.

### Three bugs that surfaced

**Bug 1: stale artifact filename in `verify-tests-exist`.**
PR #20 renamed the test-gen quality report from
`test-gen-quality-report.json` to `test-gen-validate-report.json`
(the new contract-aware validator's output). The
`verify-tests-exist` node still read the old name. Found nothing
→ exited 1 with "Generated tests failed lint/typecheck quality
gate." The actual failure mode of the third run. Same name
also referenced in the repair-quality prompt (three places).

**Bug 2: collapsed channels.** Both
`task-verify-tests-exist.ts` and `task-commit-push.ts`
emitted narration AND structured JSON on stdout. The YAML node
captured to a temp file and ran `tail -1` to extract the JSON.
Fragile on multi-line JSON, truncated output, early exits,
trailing newlines. Same pattern in `bug-pipeline.yaml`'s
`commit-and-push` node.

**Bug 3: validator overwrites its own iteration-1 report.**
When `validate-generated-tests-1` reports `passed: false`,
`repair-generated-tests` fires, then `validate-generated-tests-2`
runs the same script and overwrites the same file. After a
successful repair the original failure detail is gone — no
retro-diagnosis possible.

### Fixes (this PR)

- **Filename** consistency. `verify-tests-exist` reads
  `test-gen-validate-report.json`. Repair-quality prompt
  updated to the new name (three places).
- **Channel separation** done right per the Archon contract.
  Both scripts now `writeFile` their full report to
  `$ARTIFACTS_DIR` (information), then `process.stdout.write` a
  small JSON status object (state). YAML nodes drop the `>` and
  `tail -1` shim; they just run the script. Same fix applied to
  `bug-pipeline.yaml`'s `commit-and-push` node.
- **Validator iteration preservation.**
  `validate-generated-tests-2` copies the existing report aside
  as `test-gen-validate-report.attempt-1.json` before re-running.
  Matches the `feedback.attempt-N.json` pattern in
  `task-implement`.

### Meta-lesson

Two passes of the same class of error in this run alone, now
crystallized:

> **When changing an artifact contract or output convention,
> sweep all consumers.** Bug 1 was renaming a file without
> updating its readers. Bug 2 was wrapping a script in YAML
> redirect-plumbing rather than fixing the script to follow the
> right channel convention. Both were "fixed half the system,
> left the other half referencing the old shape."

This is the same pattern as last entry's "fix the upstream
emitter, not just the downstream catcher." Same family: when
fixing, find every place in the pipeline that touches the
contract you're changing — producer, consumer, doc reference,
prompt instruction — and update them all together. Otherwise
the system has two configurations of itself live simultaneously
and the surface that fails will be wherever the contract
mismatch happens to first matter.

### Also worth noting on the record

The third run **proved the upstream prompts work.** The agent
did not emit `@ts-expect-error`. The reviewer correctly
populated `typescript_escape_hatches: []`. The validator
correctly classified the natural `TS2307` import error as
expected red-state. The structural fix from PR #21 worked
exactly as designed. The failure was purely in node-to-node
plumbing — not in the agent's behavior or the validators' logic.

After these fixes, the fourth attempt should reach merge.

### State

- All three plumbing fixes implemented per the Archon
  authoring-workflows contract.
- WOR-95 reset earlier (failed run abandoned, worktree removed,
  ticket back to Backlog with `archon-blocked-pending`).
- `bun run validate` pending.

---

## Thursday, May 14 2026 · 3:37 AM CDT — Fourth WOR-95 attempt revealed a Phase-0-shape problem

The fourth run did much better. task-tests succeeded cleanly (no
escape hatches, new validator passed, structured-evidence array
properly populated). WOR-95 transitioned to In Progress.
task-implement dispatched. **Then it failed at rebase-on-main.**

### The mechanical conflict

The test-gen branch was created when main was at
`ce07bd9 ci: add four-stage placeholder workflow`. Between
task-tests and task-implement firing, main moved forward — Josh
had committed `e41d8d0 added convex-test` to main. The test-gen
agent had already rewritten `package.json` (adding eslint,
vitest, typescript, playwright as devDeps; the existing convex
dep was preserved but the new `convex-test` dep wasn't there
yet). Rebase tried to combine the two changed `package.json`s and
conflicted on the `devDependencies` block.

`rebase-on-main` aborted with the conflict, surfaced loud. The
DAG correctly cascaded: `implementation-ready` reported
`ready: false`, `fail-implementation-not-ready` fired with
`exit 1` (its job — surface the loud failure),
`merge-pr`/`transition-to-done`/etc all skipped via `when:`
conditions. **System working as designed.** No PR opened on a
broken implementation, no false Done transition. Halt-loud,
exactly Principle 3.

### What the failure surfaced

The mechanical conflict pointed at a deeper shape issue in how
the plan structures Phase 0 vs the rest of the work. Looking at
the plan order:

| Order | Ticket | Surface | Assumes |
|---|---|---|---|
| P0.1 | Convex Cloud Project | human | — |
| T1  | `convex/schema.ts` | convex-schema | `convex/` dir exists, convex installed, tsconfig present |
| P0.2 | Anthropic API Key | human | — |
| T2  | `convex/lib/stateMachine.ts` | convex-helper | same |
| P0.3 | Google OAuth Credentials | human | — |
| T3  | `convex/lib/auth.ts` | convex-helper | same |
| P0.4 | GitHub repo with Actions | human | — |
| T4  | `convex/lib/errors.ts` | convex-helper | same |
| T5-T7 | more `convex/lib/*` | convex-helper | same |
| **T8** | **App shell — Vite + React + ConvexProvider + routing** | react-page | — |

T1-T7 all assume the project is scaffolded. **T8 is where Vite +
React + ConvexProvider get set up.** Everything before T8 has to
either pretend the scaffolding exists or invent it as a side
effect. The test-gen agent for WOR-95 invented `vitest.config.ts`,
`eslint.config.js`, `tsconfig.json`, and a `package.json` with
its own choice of devDeps — none of which are the ticket's actual
"job."

### The cleaner statement (Josh's framing)

**A ticket saying "make a test for X" should not require the
agent following those instructions to install the test runner,
write the test config, configure ESLint, or invent project
scaffolding.**

The ticket gives the agent ONE job: write a test against
contract X. Everything the test needs to *run* — vitest, the
harness, the type config, the linter, the project structure —
must already exist when the ticket starts. Otherwise:

1. The agent invents it. Different invented setups across
   different tickets ⇒ divergence, conflicts on shared files
   like `package.json`/`tsconfig.json`, repeated work.
2. The agent's attention is split between "real work" and "yak
   shaving scaffolding." Quality drops.
3. The contract becomes less authoritative because the agent has
   to make scaffolding decisions the contract doesn't cover.
4. The cage assumes a stable runtime, but the runtime is being
   installed *inside* the cage. Weird interactions.

This is the same principle that justified Phase 0 in the first
place: **things that aren't the agent's job get done before the
agent shows up.** Phase 0 (as it currently exists) only covers
the *cloud-account / external-credential* layer. It should also
cover the *project-toolchain / scaffolding* layer.

### What "scaffolding Phase 0" should look like

A full Phase 0 for a Vite+Convex project should produce a `main`
that already has:

- `package.json` with the full dev toolchain installed
  (Vite, React, Convex, convex-test, Vitest, Playwright,
  TypeScript, ESLint + plugins). Locked in `package-lock.json`.
- `tsconfig.json` configured for the project's TS target.
- `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`,
  `eslint.config.js` all present with sensible defaults.
- `convex/` directory initialized (`npx convex dev --once`
  generates `_generated/` types, sets up the config).
- `src/main.tsx` stub with `<ConvexProvider>` wired up.
- `App.tsx` stub that renders something.
- CI workflow file already in place (we did this — `ci.yml`).
- `.env.example` listing every required runtime var.
- `.gitignore` with all the usual entries.

Then ticket T1 ("Convex schema") opens a worktree where all of
the above is already present, writes `convex/schema.ts`, and is
done. Branch contains only the schema file + its test file +
maybe one `package.json` line if it needs a new transitive
import. No `npm install` invocations from inside ticket work. No
config files invented by agents. No package.json conflicts
between sibling tickets.

### Why the plan didn't include this

The mark4 decomposition treats "scaffolding" as part of T1-T7's
implicit responsibility because the *spec* doesn't separate
scaffolding from feature work. The TechSpec describes "the system
uses Vite + React + Convex" as a fact about the project, not as
an explicit setup ticket. The decomposer reads that and produces
tickets for what the spec mentions explicitly: schema, state
machine, auth helper, etc. The scaffolding is *implied* but not
*decomposed*.

### Future-fix for the rubric

Adding a `scaffolding_completeness` dimension to the mark4
evaluator: **before the first code ticket runs, the repo must
contain enough toolchain that every subsequent ticket can run
`npm test` without modifying any config file.** If the plan
doesn't include scaffolding tickets (or doesn't include them as
Phase 0 / very-early), it should be a `required_repair`.

The simpler version: every plan should have **exactly one
"project initialization" ticket** — either as P0.N (operator
runs `npm create vite + npx convex init` and commits the result)
or as T0 (agent-driven scaffolding-only ticket with no test
target, just `set up the project to spec`). After that ticket
lands, every subsequent ticket inherits a properly-configured
repo.

### What we did right now (operationally)

Josh's manual `e41d8d0 added convex-test` commit was actually
*doing* the missing scaffolding step by hand. The conflict
happened because the agent had already invented the scaffolding
in the test-gen branch before the operator added the same
toolchain to main. **The conflict is a structural symptom of
"two paths trying to scaffold the same thing."**

The fix for this specific run: discard the test-gen branch,
re-fire WOR-95 off the now-current main (which has
`convex-test` already in devDeps). The agent will start in a
better-scaffolded repo. It might still write `eslint.config.js`
etc. (since those aren't in main yet) — so the package.json
conflict could recur if Josh commits more toolchain to main
between attempts. The robust answer is the full "scaffolding
Phase 0" above. For today: re-fire, observe, journal.

### State

- Failed task-tests + task-implement abandoned (`557cd9cc`,
  `5c87e707`).
- `archon/task-wor-95` deleted (origin + local) and worktree
  removed.
- Source clone pulled to `e41d8d0` (now has convex-test).
- WOR-95 reset to Backlog + `archon-blocked-pending`.
- Fifth attempt fired: task-tests `3edd3313` running.

---

## Thursday, May 14 2026 · 4:08 AM CDT — The cage seals around broken scaffolding (deadlock)

The fifth attempt's task-tests ran clean. task-implement
dispatched. **rebase-on-main passed** (no package.json conflict —
the convex-test alignment fix worked). baseline-test passed. Dev
loop entered.

Then **the dev loop hit attempts 1, 2, 3, 4 in a row with the
same failure**: 13 of 32 vitest tests crash with
`glob is not a function` before any schema validation runs. The
schema itself (`convex/schema.ts`) is **correct** — all 11
tables, 15 indexes, validators, all matching the contract.

### What's actually broken

`vitest.config.ts` is missing
`server.deps.inline: ["convex-test"]`. Without that, vitest
treats convex-test as an external npm package and skips Vite's
transform pipeline. convex-test internally uses
`import.meta.glob` (a Vite compile-time transform). At runtime
that's undefined → crash → all 13 runtime tests fail.

The reviewer correctly diagnosed this from attempt 1. Every
review iteration says: *"vitest.config.ts must include
server.deps.inline: ['convex-test']"*. By attempt 4 the
reviewer's instructions had escalated to: *"Use the Bash tool
with a heredoc, since Write/Edit have silently failed in all
prior attempts."*

### The dev agent literally cannot fix it

`vitest.config.ts` is a **test infrastructure file**. The cage
hook in task-implement protects test-shaped paths from
implementation-side edits — exactly the load-bearing safety rail
that prevents the dev agent from gaming tests by disabling them.
The hook is doing its job.

But the file the dev agent needs to fix to make the *real* tests
run is on the protected list. **Every Write / Edit / Bash heredoc
that attempts to modify vitest.config.ts gets blocked silently.**
The agent reports success (no error surfaces); the file on disk
doesn't change; next attempt the reviewer reads the same broken
config and re-issues the same instruction.

Four attempts in. Attempt 5 will fail the same way. Then
`fail-implementation-not-ready` will fire with `exit 1`. WOR-95
stays In Progress; no PR; pipeline halts loud at the gate.

### The structural insight (this is the v3 takeaway)

This deadlock is not a bug in any single component. **Every
component is doing the right thing:**

| Component | Behavior | Correct? |
|---|---|---|
| Cage hook | Refuses to let dev agent edit `vitest.config.ts` | YES |
| Reviewer | Refuses to pass while 13 tests are crashing | YES |
| Dev agent | Tries to fix the file but is silently blocked | tries to do the right thing |
| Test-gen agent (prior phase) | Wrote a `vitest.config.ts` that didn't include the convex-test inline | the actual gap |
| Operator setup (Phase 0) | Didn't include "verify the test runner is sound" | the deeper gap |

The deadlock is what happens when **the cage seals around a
broken test environment.** The cage works perfectly when the
test infrastructure is sound — the dev agent's only job is to
make assertions pass against a runner that already runs. The
cage fails the system when the test infrastructure itself is
broken, because then "make tests pass" requires fixing the infra,
which the cage forbids.

### Phase-0 / task-tests ownership of test infrastructure

There are exactly two opportunities to author working test
infrastructure: **Phase 0 (operator) and task-tests (test-gen
agent)**. Once task-implement starts, the cage closes around
test infrastructure permanently. So:

1. **task-tests is the last writable moment.** The test-gen
   prompt should require the agent to **actually run the test
   runner** (e.g. `vitest run` on the new tests) and confirm it
   produces real test results — not crashes or import errors —
   before declaring success. If the runner can't start, the
   config is wrong; fix it now while editing is still allowed.

2. **Even better: Phase 0 handles it.** Operator setup commits a
   working `vitest.config.ts`, `playwright.config.ts`,
   `tsconfig.json`, `eslint.config.js`, and a CI-runnable smoke
   test that proves each runner works against the project's
   actual harness. Then task-tests can only *add* tests to a
   proven-working runner; it can't break the config.

The simpler statement of the same principle:

> **The scaffolding has to be proven-functional before the cage
> closes**, not assumed-functional. The system's "test runner
> works" invariant must be established before task-implement runs;
> the dev agent has no path to repair it.

### Predictions for this run

- Attempt 5 will fail identically: dev agent attempts a write,
  cage silently blocks, file unchanged, vitest still crashes,
  reviewer still fails, validation fails.
- `fail-implementation-not-ready` fires.
- DAG cascade-skips merge-pr, transition-to-done, etc.
- WOR-95: In Progress. PR #1: not opened. Run: marked failed.
- **Pipeline halts at a real architectural gap, correctly.**

### What this means for the test plan

This is the most important finding of the WOR-95 series, and
the structural change with the biggest leverage of anything we
could ship. Bigger than the prompt fixes, the validator
refactor, the comment format, all of it. **It's the difference
between "the cage works" and "the cage works when scaffolding is
done."**

For the v3 backlog or this v2 effort's final shape:

- **Add a `verify-test-runner-works` node to task-tests** — runs
  `vitest run` (or the project's actual test command) against a
  trivially-passing smoke test, confirms the runner produces
  real output. If it crashes / can't load configs / can't find
  files, halt task-tests with the same failure-loud discipline.
  Don't let a broken test runtime escape into task-implement
  where the cage will lock it away.
- **OR add a Phase 0 ticket: "Verify project scaffolding is
  test-runner-ready."** Operator runs `npm test -- --run` on a
  baseline smoke test before promoting any feature ticket.
- **Most ambitious: a Phase 0 ticket that's literally
  `npm create vite + npx convex init + add all configs + write
  smoke test + commit + push`**, owned by an operator-driven
  setup workflow. Then every ticket starts in a fully-scaffolded
  repo with a proven-working test runner.

For now: **let the fifth run fail, observe it halt loud at the
deadlock, journal the failure**, and treat that as the closing
data point of the WOR-95 series. The system halted correctly at
a real gap. The next round of work is the scaffolding-readiness
fix above.

---

## Thursday, May 14 2026 · 4:17 AM CDT — Decision: add a T0 scaffolding ticket to the mark4 decomposer

The cage-around-broken-scaffolding deadlock has a clean answer
that doesn't require any new workflow type, prompt, or engine
change:

> **The decomposer should always produce a T0 "set up the test
> infrastructure" ticket that every other code ticket depends on.**

A T0 ticket fits the existing workflow shape perfectly:

- `task_id: T0`, `surface: scaffolding`,
  `depends_on: [P0.1, P0.2, P0.3, P0.4]` (all the Phase 0
  credential/account tickets).
- Every other T-numbered ticket gets `T0` added to its
  `depends_on` array.
- The contract for T0 names the test-infrastructure files the
  project needs (`vitest.config.ts`, `tsconfig.json`,
  `eslint.config.js`, `playwright.config.ts`, etc.) and any
  package-level commitments (devDeps, `lint` / `typecheck` /
  `test` scripts).
- The AC for T0 is verifiable: "`npm test`, `npm run lint`,
  `npm run typecheck` all run successfully on a trivial smoke
  test."
- The task-tests agent for T0 writes the config files **and a
  smoke test**. The smoke test is just the proof-of-life for the
  runner.
- The dev agent on T0 has nothing to do — the smoke test passes
  with no production code needed. validate-1 succeeds first try,
  PR opens with just the scaffolding commits, reviewer passes
  (it's just config), merge happens, task-done fires.
- Every downstream ticket starts in a worktree with proven-working
  scaffolding. **The cage closes around a known-good test
  environment, every time.**

### What changes in mark4

Add a `scaffolding_completeness` dimension to the adversarial
evaluator's Pass 2 (structure). Required entries it must verify:

1. A scaffolding ticket exists at the front of the plan (T0 or
   equivalent), explicitly listing the test-infrastructure files
   the project needs.
2. Its `depends_on` includes all Phase 0 tickets.
3. Every other code ticket transitively `depends_on: T0`.
4. The scaffolding ticket's contract names the test commands
   that must work (`npm test`, etc.) and includes a smoke test.

Scoring < passThreshold = `required_repair`. Missing T0 means
the plan is structurally incomplete.

This is a small addition to the prompt (one new dimension, a few
lines on the rubric). Big leverage — it prevents the
cage-around-broken-scaffolding deadlock for every future project
the decomposer touches.

### What we're doing for THIS run

Not re-running decomposition. Not amending the plan
mechanically. Instead, treating the missing T0 as a fact of
WOR-90's plan and doing the equivalent scaffolding work by hand
as if we were the workflow agent. Documenting it as a new child
ticket under WOR-90 with a comment explaining why the work is
being done outside the pipeline.

Specifically:
- Create a new Jira ticket as a child of WOR-90.
- Title: something like "T0 — Project test scaffolding (manual,
  missing from decomposition)".
- Comment on it explaining: WOR-90's decomposition didn't
  include a T0 scaffolding ticket. The WOR-95 series demonstrated
  that without one, the cage in task-implement can't unstick
  scaffolding gaps. Rather than redoing the decomposition,
  we're filling the gap by hand and updating the mark4 rubric
  for future projects.
- Do the scaffolding work in the Clarity repo on a feature
  branch, the same files the workflow would produce.
- Commit, push, open PR, merge into main.
- Mark the Jira ticket Done.

Then re-fire WOR-95 fresh; the test-gen branch will start off a
main with working scaffolding, and the cage-around-broken
deadlock can't happen.

The journal entry for this is the audit trail. The Jira ticket
is the operational record. The mark4 rubric change is the
permanent fix.

---

## Thursday, May 14 2026 · 4:53 AM CDT — First end-to-end hands-off success on Clarity

Sixth WOR-95 attempt completed. After the manual T0 scaffolding
work (committed via Clarity PR #2 / WOR-138), the entire chain
ran without a single human touch:

- `task-tests` ran. New contract authored. Tests written
  (without escape hatches, validator approved). Branch
  pushed, ticket transitioned to In Progress.
- `task-implement` ran. Rebase clean (no package.json
  conflict — the scaffolding lives on main). Baseline-test
  passed. **Dev attempt 1 converged first try** — no
  retries needed. The Convex schema implementation was
  correct on the first attempt because the test runtime
  worked from the start.
- `implementation-quality-final` approved.
- `generate-docs` produced the changelog fragment + data
  model docs.
- `open-pr` opened Clarity PR #3.
- All 5 PR reviewers approved (scope, code,
  error-handling, comment-quality, docs-impact). The only
  observation was a test-path-convention drift
  (`tests/wor-95/` vs the contract's `tests/unit/`) and
  the reviewer correctly treated it as a non-blocking
  note rather than a `required_repair`.
- `synthesize` returned `approve`. `parse-synthesis`
  routed to merge.
- `merge-pr` squash-merged PR #3 into main.
- `task-transition-to-done` moved WOR-95 to Done.
- `task-done` swept; zero promotable tickets (everything
  else still labeled). Pipeline returned to the
  paused-checkpoint state.

**Total intervention from us during the autonomous phase:
zero.** Strip label, transition Backlog → SfD, and walk
away. Then come back to a merged PR, a Done ticket, a
schema file on main, and a system back at paused.

This is the result we've been building toward.

### What was the difference

The scaffolding fix from WOR-138 (the manual T0). With
working `vitest.config.ts`, `tsconfig.json`,
`eslint.config.js`, `playwright.config.ts`, and all the
devDependencies pre-committed to main, the test-gen agent
didn't have to invent any configs. The dev agent's cage
closed around a known-good environment. No deadlock
possible.

Every prior failure mode — escape hatches, validator
plumbing, comment format, rebase conflicts, the
cage-around-broken-scaffolding deadlock — all of them
had been fixed in PRs #20, #21, #22, plus the manual
WOR-138 scaffolding. The sixth attempt is the first one
to run on a fully-fixed pipeline.

### The remaining drift surfaced by the run

The reviewer noted that test paths drifted: the contract
said `tests/unit/schema.test.ts`, the test-gen agent
wrote `tests/wor-95/schema.test.ts`. Both sides have
their own convention; nothing picks a winner. The agent
defaulted to its prompt's `tests/<task-id>/` pattern and
ignored the contract's `tested_by[].file` paths.

Cause: the `archon-generate-tests.md` prompt had baked-in
language directing tests to `tests/<task-id>/`. **The
contract was correct**; the test-gen prompt was
overriding it.

Fix shipped with this entry: rewrote the
`archon-generate-tests.md` Phase 3 to make the contract
authoritative. The agent now reads `tested_by[].file`
and writes each test at exactly that path. No prompt-side
fallback to per-task-id folders.

The deeper lesson, again: **when two parts of the
pipeline have overlapping responsibilities for the same
decision, only one of them should be authoritative.**
We had a contract author saying "tests go at path X" AND
a test-gen prompt saying "tests go at path Y." Whichever
the agent reads last wins. The fix is to say it once and
have the other side defer to it.

This is the same family of issue as the bash-node output
contract (state-on-stdout vs file-in-ARTIFACTS_DIR — two
ways to communicate, with the doc clarifying which one
is canonical for which kind of data). And the
"@ts-expect-error vs no-suppressions" issue (test-gen
prompt said use it, reviewer prompt said don't — until
PR #21 made them agree). Pattern: **find the conflicting
sources of truth and pick one.**

### State

- WOR-95: Done. Clarity main now has `convex/schema.ts`
  with all 11 tables.
- Clarity PRs #2 + #3 merged. WOR-138 + WOR-95 both Done.
- Pipeline at paused-checkpoint state with 45 remaining
  tickets, all labeled `archon-blocked-pending`.
- Local autonomous-run branches (`archon/task-wor-95`,
  `archon/task-wor-138`) cleaned up.
- `archon-generate-tests.md` prompt fixed to defer to
  contract paths.

### What we ship next

This PR commits the prompt fix + this journal entry.
After it merges, we can release the next WOR ticket (a
foundation-layer convex-helper like WOR-100 privacy
filter or WOR-101 transcript compression) and see whether
the now-tightened convention propagates correctly.

The remaining structural improvement (mark4 decomposer
producing a T0 scaffolding ticket automatically) stays
on the v3 backlog — important but not urgent. Until then,
operators do scaffolding manually on each new project.



---

## Entry — 2026-05-14, 12:05 CDT — The Silent SKIP

### Symptom

WOR-100 task-implement finished `dev-attempt-1` and the reviewer signed
off cleanly: "All blocking validation gates (lint, typecheck) passed."
Josh asked why vitest wasn't mentioned. I checked
`artifacts/runs/<runId>/test-results/attempt-1/` — only `lint.log` and
`typecheck.log` were there. No `vitest.log`. The gate hadn't run.

### Root cause

`task-run-validation.sh` resolved its vitest scope via
`find_ticket_dir tests` — case-insensitive lookup of
`tests/<ISSUE_KEY>/`. Two days ago I merged PR #24, which changed the
contract-author prompt to defer to the project's existing test
convention (Clarity uses `tests/unit/`, not `tests/<TICKET>/`). I
audited the contract-author emitter and the test-gen consumer that
reads the contract. I never grepped the validator.

So from WOR-95 onward, the per-ticket directory simply doesn't exist
in any run. The validator's `[ -d "$VITEST_DIR" ]` branch falls into
`skip_gate "vitest" "$VITEST_DIR/ does not exist"`. The skip is
treated as "not blocking, not relevant" by `add_gate`, and the
reviewer's prompt reads "all blocking gates passed" as true because
the only gates with status `failed` are... none.

Five tickets (WOR-95, 96, 97, 98, 99) merged to Clarity `main` without
their unit tests being executed by the implement-stage validator. The
tests *had* been generated correctly by the task-tests workflow earlier,
but task-implement's job is to re-run them against the implementation
and confirm green. That step never happened.

### The damage

Re-ran the suite manually on Clarity `main` after this discovery:

- **WOR-95 (schema)**: ✅ all tests pass
- **WOR-96 (stateMachine)**: ✅ all tests pass
- **WOR-97 (auth)**: ❌ **12 of 12 tests fail** — every test that
  imports from `convex/_generated/api` or `convex/_generated/dataModel`
  errors at module load with "Could not find the _generated
  directory." The implementation is correct; the generated dir is
  gitignored and CI never runs `npx convex codegen` before vitest.
- **WOR-98 (errors)**: ✅ all tests pass
- **WOR-99 (prompts)**: ✅ all tests pass

So WOR-97 is the only real merged-broken case, and not because the
implementation is wrong — because of a separate gitignore problem that
would have surfaced loudly if the validator had actually run vitest.
The silent-skip masked the codegen issue too.

### Josh's response — and the lesson

> "WTF, YOU LITERALLY MADE THIS CHANGE, WHEN YOU MAKE A CHANGE SEE IF
> IT AFFECTS THE REST OF THE PIPELINE."

He's right. The lesson I had to write down — and saved as durable
auto-memory — is:

**Every pipeline-node change requires auditing the downstream
consumers of its outputs/artifacts/paths.** Pipeline DAGs are wider
than they look because bash nodes embed implicit consumers. Grep is
not optional. "I changed an upstream prompt; let me check who reads
the artifact it produces" should be the reflex, not a step I skip
because the change looks self-contained.

### The fix

Two PRs:

**Archon PR #25** (validator):
- `VITEST_DIR=tests`, `PLAYWRIGHT_DIR=e2e` — scope to the whole tree,
  not per-ticket. The cage in task-implement forbids the dev agent
  from editing test files, so broader scope can't regress unrelated
  tests; it only catches genuine implementation drift.
- New `fail_gate` helper. Missing `tests/` is now FAIL, not SKIP.
  Every task-implement ticket implies a unit-test artifact; a silent
  SKIP let the gate disappear. Defense-in-depth so the next path
  convention change can't silently re-introduce this bug.

**Clarity PR #10** (project):
- Commit `convex/_generated/` (remove from `.gitignore`). Vitest no
  longer needs an implicit `npx convex codegen` pre-step to resolve
  the `api`/`dataModel` imports. After this merges, WOR-97's tests go
  from 0/12 to 12/12 retroactively. Convention: re-run codegen and
  commit the diff whenever schema or function signatures change.

### What I'm taking forward

1. Auto-memory `feedback_pipeline_change_downstream_audit.md` saved
   so future-me can't miss it. Indexed in `MEMORY.md`.
2. The fail-not-skip pattern generalizes. Anywhere the pipeline has a
   `if [ -d X ]; then run; else skip; fi` shape, ask: "Is missing X a
   project misconfiguration that should fail, or a genuinely optional
   path?" If the former, FAIL — silent SKIP is the worst of both
   worlds.
3. Clarity's pattern (gitignored `_generated`) is something other
   Convex projects will hit too. If we ever generalize Archie beyond
   Clarity, the "project needs to commit code-generated files that
   tests import" guidance belongs in the project-bootstrap checklist,
   not as folklore in this journal.

### What we ship next

Once both PRs merge: re-fire WOR-100 (it was abandoned mid-run when I
discovered the bug). Then let the auto-sweep release the rest of the
backlog one ticket at a time.
