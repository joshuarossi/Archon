---
description: Repair generated tests according to the test review verdict. Edits tests only; preserves AC coverage.
argument-hint: (none - reads test-review-latest.json from $ARTIFACTS_DIR)
---

# Repair Tests From Review

**Input**: `$ARTIFACTS_DIR/test-review-latest.json`

---

## Your Mission

Repair generated tests according to `$ARTIFACTS_DIR/test-review-latest.json`.
Preserve acceptance-criterion coverage while removing weak, misleading,
or test-harness-shaped behavior.

## Phase 1: LOAD - Read Repair Spec

Read:
- `$ARTIFACTS_DIR/contract.md` — canonical. The interfaces named
  here are the source of truth; any repair that pulls a test
  away from the contract is wrong.
- `$ARTIFACTS_DIR/task-context.md`
- `$ARTIFACTS_DIR/test-review-latest.json`
- Generated tests and test config files named in the review

**PHASE_1_CHECKPOINT:**
- [ ] Contract is loaded — you know which file paths, exports, and
      signatures are canonical
- [ ] Every required repair is understood
- [ ] Each repair is mapped to a generated test or test config file
- [ ] No production source file is in scope

## Phase 2: IMPLEMENT - Repair Test Artifacts

Edit only generated tests, fixtures, test configuration, or minimal test
tooling.

**Priority order:** address `selector_conflicts` and
`unflushed_timer_tests` from the review FIRST. These are the
mechanically broken items that will burn the dev-loop budget on
an impossible target if not fixed. Common fixes:

- Anchored regex (`/^Copy link$/i`) instead of substring
  (`/copy link/i`) when multiple elements share a substring
  accessible name. The contract names visible text and aria-labels;
  use those to determine which selector form is unambiguous.
- Use `getByLabelText`, `getByTestId`, or a more specific
  `getByRole` query when the simpler one is ambiguous.
- Wrap `vi.advanceTimersByTime(...)` in `await act(async () => { ... })`
  and the subsequent assertion in `await waitFor(() => ...)`.
- Delete `__stubs__/X.ts` files; switch the test's import to the
  contracted path **without any suppression**. At red state the
  import will produce a `TS2307 "Cannot find module"` error from
  TypeScript — that is the expected red-state error, and the
  contract-aware validator (`test-gen-validate.ts`) tolerates it.

If the review flagged `typescript_escape_hatches` entries,
**remove every suppression**. Each entry names the file, line,
pattern, and offending text. For each:

- Delete the `@ts-expect-error`, `@ts-ignore`, or `@ts-nocheck`
  comment outright. Do not "narrow" it. Do not move it. Delete it.
- Replace `: any` annotations with the real type. If the test is
  doing dynamic indexing that requires the `any`, the test design
  is wrong — restructure to use a typed accessor or the typed
  contract shape. Do not paper over with `: any`.
- Replace `as any` / `as unknown` casts with a proper type. Same
  reasoning: if the test inherently can't be typed, the test
  design needs rethinking.
- After removing the suppressions, the resulting test will likely
  produce TypeScript errors:
  - **`TS2307 "Cannot find module"` on contract-promised paths is
    expected and accepted at red state.** Leave it. `tsc` is not
    expected to pass at red state — the validator knows this and
    tolerates these specific errors.
  - **Any other tsc error (TS7053, TS2304, TS2322, etc.) is a real
    test-code bug that the suppression had been hiding.** Fix the
    test code. Restructure the dynamic indexing. Use a proper
    typed accessor. Re-design the assertion. Do not re-suppress.

After the mechanical issues are resolved, address coverage gaps,
weak tests, and other repair items.

Forbidden:
- Editing production implementation files under `src/`, `convex/`,
  `app/`, or equivalent source directories
- Removing acceptance-criterion coverage
- Weakening assertions just to avoid red-state failures
- Mocking the system under test
- Encoding fake IDs, selectors, or fixture-specific behavior unless they
  are part of the public product contract
- **Reintroducing TypeScript escape hatches.** `@ts-expect-error`,
  `@ts-ignore`, `@ts-nocheck`, `: any`, `any[]`, `as any`, and
  `as unknown` are absolute hard-fails in every test file. Never
  add them back during repair, even to "make typecheck pass." The
  validator and reviewer will reject them again.

**PHASE_2_CHECKPOINT:**
- [ ] Review-required repairs are implemented
- [ ] No TypeScript suppressions in any test file after repair
      (`@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`, `: any`,
      `any[]`, `as any`, `as unknown`)
- [ ] Valid TypeScript everywhere else. The only acceptable tsc
      errors are `TS2307` on contract-promised paths.
- [ ] AC coverage is preserved or improved
- [ ] No implementation source files were edited

## Phase 3: REPORT - Summarize

Summarize files changed and which review items were repaired.

## Success Criteria

- **REVIEW_REPAIRED**: Every actionable review item was addressed.
- **AC_COVERAGE_PRESERVED**: Tests still cover the acceptance criteria.
- **NO_IMPLEMENTATION_EDITS**: Production source files are untouched.

