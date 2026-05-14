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


