#!/usr/bin/env bun
/**
 * Parse the synthesizer's consolidated-review.md into structured JSON for
 * downstream `when:` clauses to gate on. The bundled archon-synthesize-review
 * command writes prose to stdout and a markdown artifact to disk; it does NOT
 * emit a JSON `decision` field. This bridge node reads the markdown verdict
 * and re-emits it as `{decision: "approve"|"changes_requested"|"needs_discussion"}`.
 *
 * Reads:
 *   $ARTIFACTS_DIR/review/consolidated-review.md
 *
 * Writes (stdout, JSON-only — narrative goes to stderr):
 *   {"decision":"approve|changes_requested|needs_discussion",
 *    "verdict_raw":"APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION",
 *    "review_path":"<path>"}
 */
import { readFile } from 'node:fs/promises';

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

const reviewPath = `${artifactsDir}/review/consolidated-review.md`;

let md: string;
try {
  md = await readFile(reviewPath, 'utf8');
} catch (err) {
  const e = err as Error;
  console.error(`Failed to read ${reviewPath}: ${e.message}`);
  // Fail-closed: if there's no review, treat as changes_requested so we don't
  // accidentally merge an unreviewed PR.
  process.stdout.write(
    JSON.stringify({
      decision: 'changes_requested',
      verdict_raw: 'MISSING',
      review_path: reviewPath,
      error: e.message,
    }),
  );
  process.exit(0);
}

// The bundled command emits one of these patterns somewhere in the markdown:
//   **Overall Verdict**: APPROVE
//   **Verdict**: `APPROVE`
//   **Verdict**: REQUEST_CHANGES
// Match permissively: any "verdict" line followed by APPROVE / REQUEST_CHANGES
// / NEEDS_DISCUSSION (case-insensitive, optional formatting around the value).
const verdictPattern = /verdict[^A-Za-z]*?(APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION)/i;
const match = verdictPattern.exec(md);
const verdictRaw = match ? match[1].toUpperCase() : 'UNKNOWN';

const decisionMap: Record<string, string> = {
  APPROVE: 'approve',
  REQUEST_CHANGES: 'changes_requested',
  NEEDS_DISCUSSION: 'needs_discussion',
};

const decision = decisionMap[verdictRaw] ?? 'changes_requested'; // fail-closed

console.error(`Parsed verdict: ${verdictRaw} → decision=${decision}`);

process.stdout.write(
  JSON.stringify({
    decision,
    verdict_raw: verdictRaw,
    review_path: reviewPath,
  }),
);
