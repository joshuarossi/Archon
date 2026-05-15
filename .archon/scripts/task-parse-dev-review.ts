#!/usr/bin/env bun
/**
 * Parses dev-review-latest.json and emits a structured verdict for
 * downstream `when:` gates.
 *
 * Three verdicts (mutually exclusive):
 *
 *   approve            → reviewer says passed AND all blocking gates pass.
 *                        Workflow proceeds to implementation-quality-final
 *                        which routes to open-pr.
 *
 *   test_needs_edits   → reviewer flagged required_repairs but EVERY
 *                        repair entry's `file` is a test path
 *                        (tests/**, e2e/**, __tests__/**, *.test.*,
 *                        *.spec.*, vitest/jest/playwright config). The
 *                        defect is in the test, not the implementation;
 *                        routes to edit-tests-loop instead of wasting
 *                        further dev-attempts on a broken test.
 *
 *   reject             → reviewer flagged required_repairs that include at
 *                        least one production path. Routes to the next
 *                        dev-attempt (cage held).
 *
 * Reads:
 *   $ARTIFACTS_DIR/dev-review-latest.json
 *
 * Writes (stdout, JSON-only — narrative goes to stderr):
 *   {
 *     "passed": boolean,
 *     "verdict": "approve" | "reject" | "test_needs_edits",
 *     "required_repairs": <number>,
 *     "test_paths": <number>  // count of repair entries whose file is a test path
 *   }
 *
 * `passed` mirrors the reviewer's own boolean for backward compatibility
 * with any consumer that hasn't migrated to `verdict`.
 */
import { readFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.stdout.write(
    JSON.stringify({
      passed: false,
      verdict: 'reject',
      required_repairs: 0,
      test_paths: 0,
      reason: 'ARTIFACTS_DIR unset',
    }),
  );
  process.exit(1);
}

const reviewPath = `${artifactsDir}/dev-review-latest.json`;

try {
  await access(reviewPath, fsConstants.F_OK);
} catch {
  console.error(`Missing ${reviewPath}; defaulting to reject.`);
  process.stdout.write(
    JSON.stringify({
      passed: false,
      verdict: 'reject',
      required_repairs: 0,
      test_paths: 0,
      reason: 'missing dev-review-latest.json',
    }),
  );
  process.exit(0);
}

interface RepairEntry {
  file?: unknown;
}
interface DevReview {
  passed?: unknown;
  required_repairs?: unknown;
}

const review = JSON.parse(await readFile(reviewPath, 'utf8')) as DevReview;

const passed = review.passed === true;

// Same test-path classification used by implementation-quality-final.
// Match anywhere in the path: tests/, test/, e2e/, __tests__/, files
// ending in .test.* / .spec.*, and vitest/jest/playwright/cypress config
// files at any depth.
const TEST_PATH_RE =
  /(^|\/)(tests?|e2e|__tests__)(\/|$)|\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$|(^|\/)(vitest|playwright|jest|cypress)\.config\./;

function isTestPath(p: unknown): boolean {
  return typeof p === 'string' && TEST_PATH_RE.test(p);
}

const repairs: RepairEntry[] = Array.isArray(review.required_repairs)
  ? (review.required_repairs as RepairEntry[])
  : [];
const repairCount = repairs.length;
const testPathCount = repairs.filter(r => isTestPath(r.file)).length;

let verdict: 'approve' | 'reject' | 'test_needs_edits';
if (passed) {
  verdict = 'approve';
} else if (repairCount > 0 && testPathCount === repairCount) {
  // Every repair is in a test path: the defect is on the test side.
  verdict = 'test_needs_edits';
} else {
  // No repairs (vague verdict) OR at least one production-side repair.
  // Either way, the dev-loop should continue trying.
  verdict = 'reject';
}

console.error(
  `Parsed dev-review: passed=${passed}, repairs=${repairCount} (${testPathCount} test-path) → verdict=${verdict}`,
);

process.stdout.write(
  JSON.stringify({
    passed,
    verdict,
    required_repairs: repairCount,
    test_paths: testPathCount,
  }),
);
