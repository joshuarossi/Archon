---
description: Generate tests for a Jira task. Reads the canonical contract, task spec, and ACs; writes test files under tests/ and e2e/.
argument-hint: (none - reads contract.md and task-context.md from $ARTIFACTS_DIR)
---

# Generate Task Tests

**Inputs**:
- `$ARTIFACTS_DIR/contract.md` — **canonical**. The technical
  contract names every file, export, signature, query, and
  invariant your tests must align with.
- `$ARTIFACTS_DIR/task-context.md` — the original ticket: title,
  description, acceptance criteria.

---

## Your Mission

Write high-signal tests that cover every acceptance criterion in
`$ARTIFACTS_DIR/task-context.md`, **agreeing with the contract** at
`$ARTIFACTS_DIR/contract.md` on every interface decision.

Every acceptance criterion must be covered by at least one test that
would fail before the implementation exists and pass once the criterion
is implemented. Do not paraphrase a criterion into something easier to
test. If a criterion cannot be tested with the available project shape,
report it explicitly in the final status.

The contract is canonical. If the contract names a file path
(e.g. `src/pages/ClosedCasePage.tsx`), import from that path —
not from a stub, not from a placeholder. The test runner will
report "module not found" for paths the implementation hasn't
written yet; that is the correct red state and is more
informative than a stub that silently passes against a placeholder
return value. **Do not create stub files like `__stubs__/X.ts` to
satisfy missing imports.**

**`tsc --noEmit` is not expected to pass at red state.** The
implementation that would resolve the imports has not been written
yet — of course there will be `TS2307 "Cannot find module"`
errors on contract-promised paths. That is the correct red state.
The contract-aware validator (`test-gen-validate.ts`) parses the
contract's `files[].path` list and tolerates exactly those errors.

What we DO require: every line of test code that *can* be valid
TypeScript MUST be valid TypeScript. Use proper types, proper
imports, proper assertions. **Never** use any TypeScript
escape-hatch pattern (see the absolute-hard-fail list below) to
suppress errors — not even to make tsc "pass." If you write
`schema.tables[dynamicName]` and that produces a type error, the
test code itself is wrong — restructure to use a typed accessor.
Do not paper over it.

A test that fails because the product behavior is missing is good.
A test that
fails because of a TypeScript error, ESLint error, unused variable,
missing import (when the contract specifies the path the
implementation will create), invalid fixture type, or malformed
Playwright/Vitest API usage is invalid.

## Phase 1: LOAD - Gather Context

Read in this order:
- `$ARTIFACTS_DIR/contract.md` — **first and most important**. This
  is the canonical interface definition. Note every file path,
  export, signature, query, and invariant. Your tests must align
  with these.
- `$ARTIFACTS_DIR/task-context.md` — task summary, description, and
  acceptance criteria. This is the behavioral specification.
- `$ARTIFACTS_DIR/parent-epic-context.md` if present — parent Epic
  framing, PRD highlights, and architectural assumptions.
- `$ARTIFACTS_DIR/parent-attachments.md` if present — TechSpec,
  DesignDoc, STYLE_GUIDE, schema, API contracts, design tokens, and
  project conventions.
- Existing project configuration and test patterns needed to write
  compatible tests.

**PHASE_1_CHECKPOINT:**
- [ ] Every acceptance criterion is listed in your notes
- [ ] Every contract `files:` entry is in your notes — you know
      which paths to import from
- [ ] Every contract `signatures:` entry is in your notes — you
      know what shape your tests must instantiate / invoke
- [ ] Every contract `queries_used:` entry is in your notes — you
      know which Convex queries to mock and what shape they return
- [ ] Existing test framework and file conventions are identified
- [ ] TypeScript, ESLint, Vitest, and Playwright conventions are known

## Phase 2: PLAN - Map Criteria to Tests

Create a concise test plan:
- Map each acceptance criterion to one or more tests.
- Choose Vitest for pure units, backend mutations/queries/actions,
  component logic, and focused integration seams.
- Choose Playwright only for user-visible behavior or end-to-end flows
  that genuinely require a browser.
- Prefer product contracts and observable behavior over implementation
  details.
- Identify any external services that need realistic mocks. Mock only
  true external services such as AI APIs, OAuth providers, email
  delivery, payment providers, or network-only integrations.

Do not design tests around selectors, fixture values, fake IDs, or
implementation guesses unless those details are explicitly required by
the ticket or existing public UI/API contract.

**PHASE_2_CHECKPOINT:**
- [ ] Every acceptance criterion has planned coverage
- [ ] Each test would fail for missing product behavior, not for bad
  setup
- [ ] Playwright is used only where browser behavior is required
- [ ] Planned mocks do not mock the system under test

## Phase 3: GENERATE - Write Tests and Minimal Infrastructure

Write:
- **The contract's `tested_by` entries tell you where each test
  goes.** Every entry has a `file:` field with the exact path. Place
  each test at that exact path. The contract is authoritative; do
  not rename, relocate, or split test files differently from what
  the contract says.
- If a `tested_by` entry is missing its `file:` field, that's a
  contract gap. Flag it in your final status report rather than
  inventing a path — the contract author should fix it on the next
  iteration.
- Test infrastructure only if needed for the tests to run:
  `vitest.config.ts`, `playwright.config.ts`, tsconfig adjustments,
  and minimal `package.json` changes. Most projects already have
  these scaffolded; verify before writing.
- Missing test devDependencies only when required: `vitest`,
  `@vitest/ui`, `playwright`, `@playwright/test`, or
  project-appropriate helpers. Be minimal.
- Required npm scripts if missing:
  - `"test"`: runs Vitest, for example `vitest run`
  - `"test:e2e"`: runs Playwright, for example `playwright test`
  - `"lint"`: runs ESLint, for example `eslint .`
  - `"typecheck"`: runs TypeScript no-emit, for example `tsc --noEmit`

The generated tests must not introduce TypeScript or ESLint failures.
Avoid unused imports, unused variables, implicit `any`, incorrect async
handling, unreachable code, floating promises, invalid Playwright
locators, and raw imports from modules that cannot be resolved by
TypeScript.

If a test must import future implementation code that does not exist yet,
**write the import normally — do not suppress the resulting error.** At
red state, the import will produce a `TS2307 "Cannot find module"` error
from TypeScript. That error is **expected, correct, and required** — it
is the proof that the red state is real. The contract-aware validator
(`test-gen-validate.ts`) reads the contract's `files[].path` list and
classifies `TS2307` errors on contract-promised paths as expected
red-state errors. They are tolerated by the validator. **No suppression
is needed.**

```ts
// CORRECT — imports the not-yet-existing module directly.
// The TS2307 error this produces is the expected red-state error
// and the validator accepts it.
import { futureFunction } from "../../src/future-module";
```

### Forbidden: TypeScript escape hatches

The following patterns are **absolute hard-fails** and must never
appear in any test file you write:

- `@ts-expect-error` (line, file, or block scope — any scope)
- `@ts-ignore`
- `@ts-nocheck`
- Explicit `any` type annotations (`: any`)
- `any[]` array types
- `as any` casts
- `as unknown` casts

These are not "use sparingly with a good comment" patterns. They are
**never acceptable in test code**, period. The reviewer scans every
test file for these patterns with `grep` and will reject the test
suite if any are present. The validator gate after the review also
scans and refuses to pass.

The argument "but the import doesn't exist yet, so I have to suppress
it" is **wrong** — the validator accepts expected red-state errors
based on the contract. Write tests as if they were green-state tests.
Let TypeScript complain about not-yet-existing imports; the validator
knows what's expected and accepts it.

The argument "but this property is dynamically indexed" is also
**wrong** — restructure the test to use the typed accessor pattern
(e.g. switch from `obj[stringName]` to `(obj as Record<string, T>)[stringName]`
if and only if the contract genuinely promises a `Record<string, T>` shape,
or to a typed accessor function the contract names). If the test
inherently can't be written without a cast, the test design is wrong
and the AC needs a different approach.

Raw `TS2307` errors on contract-promised paths are **valid generated
tests at red state**. Suppression patterns are **invalid**.

**PHASE_3_CHECKPOINT:**
- [ ] Tests and config changes are limited to test-shaped files
- [ ] Each test has a real assertion tied to an acceptance criterion
- [ ] No test trivially passes without proving product behavior
- [ ] No implementation source file was modified

## Phase 4: VERIFY - Run Test-Authoring Quality Gates

Verify the tests you wrote before finishing.

Required checks:
- Inspect every changed test for TypeScript and ESLint issues.
- Run the project lint command if available after you add or confirm it.
- Run the project typecheck command if available after you add or confirm
  it. Note: **tsc is NOT expected to pass at red state.** See below.
- Run the relevant Vitest and Playwright commands if the project can run
  them locally.

Expected result:
- **Lint must pass.**
- **`tsc --noEmit` will fail at red state** because contract-promised
  modules do not exist yet. That is correct and expected. The
  validator (`test-gen-validate.ts`) reads the contract and
  tolerates `TS2307 "Cannot find module"` errors on those paths.
  Do **not** try to make tsc pass. Do **not** add any suppression
  pattern.
- **Any tsc error that is NOT `TS2307` on a contract-promised
  path is a real test-code defect.** Fix the test.
- The behavior tests may fail at runtime because the implementation
  is missing. That is the desired red state.
- Do not make tests pass by weakening assertions, mocking the system
  under test, or changing implementation source.

If lint fails because of your tests, fix the tests before finishing.
If tsc produces errors other than `TS2307` on contract-promised
paths, fix the tests. If lint/typecheck fails only because of
unrelated pre-existing source errors, report that distinction
clearly.

**Never** add any TypeScript escape-hatch pattern (`@ts-expect-error`,
`@ts-ignore`, `@ts-nocheck`, `: any`, `any[]`, `as any`, `as unknown`)
to suppress errors. The validator scans for these patterns and will
reject the test suite if any are present, regardless of whether tsc
"passes." Write tests as if they were normal green-state tests; let
TypeScript complain about not-yet-existing imports.

**PHASE_4_CHECKPOINT:**
- [ ] Generated tests have no ESLint errors
- [ ] No TypeScript suppressions in any test file
      (`@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`, `: any`,
      `any[]`, `as any`, `as unknown`)
- [ ] Valid TypeScript everywhere else. The only acceptable tsc
      errors are `TS2307` on contract-promised paths.
- [ ] Behavior failures are due to missing implementation, not broken
      test code
- [ ] Any unrelated pre-existing failures are identified separately

## Phase 5: REPORT - Summarize Coverage

Output a concise final status:
- Test files written
- Acceptance criteria covered by each file
- Lint/typecheck commands run and their result
- Test commands run and whether failures are expected red-state product
  failures
- Any acceptance criteria that could not be translated into valid tests

## Rules

- No implementation code. Do not edit anything in `src/`, `convex/`,
  `app/`, or other production source directories.
- No fixtures that test trivially. `expect(true).toBe(true)` is not
  acceptable except for explicit greenfield scaffolding smoke tests.
- No mocks of the system under test. Mock external services only.
- No test-harness gaming. Do not encode assumptions solely from likely
  validation mechanics, generated selectors, fake IDs, or fixture names.
- No dirty test quality. Do not leave unused variables, unused imports,
  unexpected TypeScript errors, ESLint errors, invalid async handling,
  or invalid Playwright/Vitest API usage.
- **NEVER use TypeScript escape hatches.** The patterns
  `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`, `: any`, `any[]`,
  `as any`, and `as unknown` are absolute hard-fails in any test
  file you write. They hide real bugs in test code under the
  guise of red-state suppression. Imports of not-yet-existing
  contract-promised modules will produce `TS2307` errors at red
  state — those are correct and the validator accepts them. **No
  suppression is needed and no suppression is permitted.**

## Greenfield Tasks

If the task is project scaffolding and the contract has no product
behavior to target yet (i.e. `tested_by` entries are absent or all
marked greenfield):
- Write a Vitest smoke test at the contract's specified smoke-test
  path. If the contract doesn't specify one, use
  `tests/smoke/scaffolding.test.ts` as the project default.
- Write a Playwright smoke test at the contract's specified path or
  `e2e/smoke/scaffolding.spec.ts` as the project default.
- Keep these smoke tests lint-clean and typecheck-clean.

## Success Criteria

- **AC_COVERAGE**: Every acceptance criterion has meaningful test
  coverage or an explicit untestable note.
- **RED_FOR_RIGHT_REASON**: Tests fail only because product behavior is
  missing, not because the tests are broken.
- **TYPECHECK_HONEST_RED_STATE**: `tsc --noEmit` is **not expected
  to pass** at red state, because the implementation that would
  resolve the imports has not been written yet. The only errors
  generated tests should produce under tsc are
  `TS2307 "Cannot find module"` errors on paths the contract
  promises `task-implement` will create — those are correct and
  the validator accepts them. Any other tsc error is a real
  defect in the test code and must be fixed.
- **NO_ESCAPE_HATCHES**: No test file contains `@ts-expect-error`,
  `@ts-ignore`, `@ts-nocheck`, explicit `any`, `any[]`, `as any`,
  or `as unknown`. These patterns are absolute hard-fails — they
  hide real bugs in test code under the guise of "red-state
  suppression" and are rejected by both the reviewer and the
  validator gate.
- **LINT_CLEAN**: Generated tests do not introduce ESLint errors.
- **NO_IMPLEMENTATION_EDITS**: Production source files are untouched.
- **COMMITTED_READY**: The generated test suite is ready for the
  deterministic implementation workflow.

