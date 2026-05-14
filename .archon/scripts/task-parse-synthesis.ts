#!/usr/bin/env bun
/**
 * Parse the synthesizer's consolidated-review.md into structured JSON for
 * downstream `when:` clauses to gate on. The bundled archon-synthesize-review
 * command writes prose to stdout and a markdown artifact to disk; it does NOT
 * emit a JSON `decision` field, so $synthesize.output.decision would resolve
 * to '' and downstream gates would always evaluate false.
 *
 * The synthesizer prompt designs THREE verdicts:
 *   APPROVE            — 0 CRITICAL, 0 HIGH, no must-fix issues → merge
 *   REQUEST_CHANGES    — ≥1 CRITICAL/HIGH that must be auto-fixed first
 *   NEEDS_DISCUSSION   — no must-fix issues, but MEDIUM/LOW the synthesizer
 *                        wants a human to weigh in on
 *
 * Routing policy (per operator decision 2026-05-14):
 *   - APPROVE → "approve" (merge)
 *   - REQUEST_CHANGES → "changes_requested" (auto-fix loop)
 *   - NEEDS_DISCUSSION + auto-fix candidates > 0 → "changes_requested"
 *     The synthesizer's own summary line ("Auto-fix Candidates: N MEDIUM/HIGH
 *     issues can be auto-fixed") tells us the count. If anything is
 *     auto-fixable, run the same auto-fix loop REQUEST_CHANGES uses —
 *     these are mechanical fixes the discussion is really about whether
 *     to bother making them. The pipeline's answer: yes, bother.
 *   - NEEDS_DISCUSSION + 0 auto-fix candidates → "needs_human_review"
 *     Genuinely "human decides." A downstream node flags the ticket
 *     for operator attention and halts; PR stays open, ticket stays In
 *     Progress until the operator merges or rejects manually.
 *
 * Reads:
 *   $ARTIFACTS_DIR/review/consolidated-review.md
 *
 * Writes (stdout, JSON-only — narrative goes to stderr):
 *   {"decision":"approve|changes_requested|needs_human_review",
 *    "verdict_raw":"APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION|MISSING|UNKNOWN",
 *    "auto_fix_count": <number>,
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
      auto_fix_count: 0,
      review_path: reviewPath,
      error: e.message,
    }),
  );
  process.exit(0);
}

// Verdict pattern matches the synthesizer template's two emission shapes:
//   **Overall Verdict**: APPROVE
//   **Verdict**: `APPROVE`
// Case-insensitive, tolerant of backticks/spacing.
const verdictPattern = /verdict[^A-Za-z]*?(APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION)/i;
const verdictMatch = verdictPattern.exec(md);
const verdictRaw = verdictMatch ? verdictMatch[1].toUpperCase() : 'UNKNOWN';

// Auto-fix-candidates count: the synthesizer's executive-summary line reads
//   **Auto-fix Candidates**: N CRITICAL + HIGH issues can be auto-fixed
//   **Auto-fix Candidates**: N MEDIUM issues can be auto-fixed
// Extract the leading integer. A 0 / missing line means nothing auto-fixable.
const autoFixPattern = /auto-fix\s*candidates[^0-9]*?(\d+)/i;
const autoFixMatch = autoFixPattern.exec(md);
const autoFixCount = autoFixMatch ? Number(autoFixMatch[1]) : 0;

let decision: 'approve' | 'changes_requested' | 'needs_human_review';
switch (verdictRaw) {
  case 'APPROVE':
    decision = 'approve';
    break;
  case 'REQUEST_CHANGES':
    decision = 'changes_requested';
    break;
  case 'NEEDS_DISCUSSION':
    decision = autoFixCount > 0 ? 'changes_requested' : 'needs_human_review';
    break;
  default:
    // UNKNOWN / missing verdict → fail-closed to human review so we don't
    // silently merge an unreviewed PR.
    decision = 'needs_human_review';
}

console.error(
  `Parsed verdict: ${verdictRaw} (auto_fix=${autoFixCount}) → decision=${decision}`,
);

process.stdout.write(
  JSON.stringify({
    decision,
    verdict_raw: verdictRaw,
    auto_fix_count: autoFixCount,
    review_path: reviewPath,
  }),
);
