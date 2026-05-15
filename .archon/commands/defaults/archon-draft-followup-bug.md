---
description: Draft a Jira Bug ticket capturing residual failures after the post-fix retry loop exhausted
argument-hint: (none — reads from $ARTIFACTS_DIR/review and $ARTIFACTS_DIR/feedback.json)
---

# Draft Follow-up Bug Ticket

The synthesizer requested changes on this PR. The auto-fix loop ran
three full attempts (`implement-fixes` → `post-fix-validation` ×3)
and every attempt failed `lint`/`typecheck`/`vitest` — usually on a
mechanical issue (closure scope, missing import, narrow signature
mismatch) that the fixer kept tripping on.

The parent PR delivers the spec's acceptance criteria at the design
level — the synthesizer's findings were correctly addressed in
substance, just imperfectly in the code. Rather than block the parent
indefinitely, the pipeline merges it and files a focused Bug ticket
that captures the **residual mechanical failure** for a fresh
agent pass.

Your job: draft that Bug ticket.

---

## Inputs

- `$ARTIFACTS_DIR/review/consolidated-review.md` — the synth's
  findings on the parent PR.
- `$ARTIFACTS_DIR/feedback.json` — the latest validator failure
  (whichever post-fix-validation attempt was last). The `gates`
  array has the failing gates with their log output.
- `$ARTIFACTS_DIR/review/fix-report.md` (and per-attempt copies
  if they exist) — what each previous fix attempt tried.
- `$ARTIFACTS_DIR/trigger-payload.json` — the parent ticket's
  `issue_key`.
- `$ARTIFACTS_DIR/pr-info.json` — `pr_number` and `pr_url` for the
  parent PR.
- The PR branch checkout (still on the worktree).

---

## Workflow

### 1. Read all inputs

Read each file listed above. You need the full picture: what the
synth wanted, what the fixer tried, what failed, where.

### 2. Identify the residual problem

The retries failed for a reason. Find it:

- Read the failing gates' logs in `feedback.json` (each gate has a
  `log` field with the tool output).
- The most important signal is the **last** failing gate — that's
  what the latest validation attempt caught.
- Cross-reference with the code: open the files mentioned in the
  log, read the current state, understand why the fixer's most
  recent change didn't satisfy the validator.

### 3. Identify the recommended fix

The fixer kept trying; you have the benefit of seeing what
*didn't* work. Reason about what *would* work:

- If it's a TypeScript narrowing/type problem, name the specific
  TS limitation and the workaround (e.g., extract narrowed value
  to a local const before passing to a callback).
- If it's a missing import or symbol, name the symbol and where
  to import it from.
- If it's a test fixture mismatch, name the fixture and the
  expected shape.
- If you can't identify a specific fix, name the failing line
  and the constraint that's being violated — even partial guidance
  helps the next agent.

The bug ticket's quality is the difference between the next agent
landing it on attempt-1 and needing another retry loop. Be
specific.

### 4. Draft the bug ticket

Write the draft to `$ARTIFACTS_DIR/followup-bug-draft.json` with
this exact shape:

```json
{
  "summary": "Fix <specific residual failure> in <file> (from <parent-key>'s review)",
  "description_markdown": "## Context\n\n... full description ...",
  "parent_issue_key": "<parent ticket key>",
  "parent_pr_number": <pr_number>,
  "parent_pr_url": "<pr_url>"
}
```

The `summary` should be ≤80 chars, specific, mechanical (not
"fix the bug"). Examples:

- "Fix TS closure narrowing on identity.email in convex/users.ts"
- "Add missing import for ZodSchema in src/lib/validate.ts"
- "Repair fixture shape mismatch in tests/unit/auth.test.ts"

The `description_markdown` should follow this template:

```markdown
## Context

Filed as an Action item from {parent-key}. {parent-key}'s post-PR
review correctly identified {original synth finding in 1-2
sentences}. The auto-fix loop attempted the change but its
implementation tripped {specific mechanical failure} that {N=3}
validator attempts could not resolve. The parent PR merged with
this residual failure; this ticket completes the fix.

## Failing state on parent's merged PR

\```
{the exact failing-gate log excerpt — short — that pinpoints the
problem}
\```

## Root cause

{1-3 paragraphs: what the underlying problem is. Name the
specific TypeScript / runtime / framework behavior at play, not
just the symptom. This is the part a focused human reviewer
would write.}

## Recommended fix

\```ts
{the corrected code, in context}
\```

{1-2 sentences explaining why this approach works where the
previous attempts didn't.}

## Acceptance Criteria

- `npx tsc --noEmit` passes (no errors in {affected file}).
- Existing tests for {affected file} continue to pass.
- {1-2 additional ACs specific to the fix — e.g. "the auth-guard
  semantics from the original synth finding remain in place".}

## Notes for the agent

- Out of scope: {anything from the original synth's findings
  that's not part of the residual failure — usually MEDIUM/LOW
  items that the parent's fix did address.}
- The previous attempt's diff is in PR #{parent-pr-number}.
  Reading it may help you avoid repeating its approach.

## Traceability

Action item from `{parent-key}`. Parent PR: #{parent-pr-number}.
```

### 5. Validate the draft

Re-read the file you just wrote. Confirm:

- `summary` is concrete and ≤80 chars.
- `description_markdown` includes the failing-gate log excerpt and
  a concrete recommended fix in a code block.
- All four fields (`summary`, `description_markdown`,
  `parent_issue_key`, `parent_pr_number`) are present.

If any check fails, rewrite the draft.

### 6. Emit success to stdout

After writing the file, emit a single JSON line to stdout
confirming the draft was created:

```json
{"drafted": "true", "draft_path": "$ARTIFACTS_DIR/followup-bug-draft.json"}
```

If you cannot draft a sensible ticket (the failure log is empty,
the synth findings are unreadable, the artifacts are missing),
emit:

```json
{"drafted": "false", "reason": "<one-line explanation>"}
```

Do NOT call the Jira API yourself. A downstream node reads this
draft and files the ticket. Your only outputs are:

1. The draft file on disk.
2. The status JSON on stdout.

---

## What NOT to do

- Do NOT call `createJiraIssue`, `createIssueLink`, or any Jira
  API. The downstream node owns that.
- Do NOT modify the parent PR's code. The retries already tried.
  Your job is to describe the problem clearly so a *new* ticket
  can be worked.
- Do NOT include findings from the synth review that the parent's
  retries *did* address. Focus only on the residual failure.
- Do NOT speculate beyond what the failure logs and code support.
  If you can't identify a specific fix, say so and describe the
  constraint being violated — partial guidance is better than
  invented guidance.
