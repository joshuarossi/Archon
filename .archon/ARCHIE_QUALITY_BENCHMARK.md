# Archie Quality Benchmark — design

**Status:** design locked (2026-05-16), NOT yet built. Build begins
only after the Clarity build phase completes (last 5 tickets land).

**Purpose:** produce a single defensible number — "the app Archie
produced is Quality X" — on a 0–100 scale where 0 = random noise,
100 = perfect, and the scale is **transferable**: the same harness,
unchanged, can score any other production app and yield a comparable
number. Without transferability the seed-deck claim ("Archie produces
~80-quality apps") is self-graded and worthless.

Threshold semantics (calibrated, not asserted — see Calibration):
- **70** = POC
- **75** = private beta
- **80** = public beta
- **85** = production-ready

## Decisions (Josh, 2026-05-16)

1. **Anchor every dimension to an external, recognized standard** —
   not an invented formula. Each axis is scored by an instrument a
   real engineering org already uses, so the number is defensible
   under technical due diligence and transferable by construction.
2. **Calibrate the harness on reference apps BEFORE scoring Clarity,
   then score Clarity blind.** Protects the objectivity claim from
   unconscious fitting-to-Clarity.
3. **Two tiers of external criteria — do not conflate them**
   (Josh, 2026-05-16, clarifying the SOC 2 example):
   - **Tier 1 — machine-verifiable (the harness's scope).** Standards
     whose technical controls a tool can check and produce evidence
     for: OWASP ASVS level, WCAG 2.2 AA, GDPR *technical* controls
     (encryption at rest, deletion/export, consent gating, no PII in
     logs), SAST/CWE + dependency-CVE cleanliness, perf SLOs,
     independent AC verification. The 0–100 is a rollup of the Tier-1
     conformance matrix.
   - **Tier 2 — human-audited (named, out of automated scope).** SOC
     2 Type II, a formal third-party penetration test, etc. These are
     attestations by real auditors over an observation window; an app
     cannot be auto-"certified" SOC 2, and the harness must never
     claim it. SOC 2 was Josh's *example of the category of external
     bar we want to be measurable against*, not a literal automated
     target. The benchmark **names** these as the recognized bars the
     app is built toward and reports Tier-1 readiness for them
     ("satisfies the engineering/technical controls a SOC 2 Type II
     or pen-test audit would examine"), explicitly deferring the
     attestation itself to human auditors when there is a business
     reason (customer requirement, raise).
   - **Process auditability is a deliberate Tier-2 asset.** A SOC 2
     audit of a product also examines the SDLC that produced it
     (change management, review, access control, deploy discipline).
     The Archie pipeline is unusually auditable on exactly these
     axes: every change ticket-traced, test-gated, synthesizer-fleet
     reviewed, branch-isolated, operator-never-touches-project-code.
     The benchmark should call this out as an asset for a future
     Tier-2 audit — without the harness pretending to grant the
     attestation.

## The five dimensions

| Dim | External anchor / instrument | 0 = | 100 = |
|---|---|---|---|
| Correctness | Spec AC pass-rate verified **independently of Archie's own test suite** (fresh E2E + exploratory against the spec) + builds & boots | nothing runs | every AC behaviorally verified against the running app |
| Code health | SQALE / maintainability rating (SonarQube-class), `tsc --strict` clean, lint, cyclomatic complexity, dead code, dependency CVEs (`npm audit`) | unmaintainable | SQALE "A", zero strict errors, no known CVEs |
| Security | OWASP ASVS — the *level achieved* (L1 ≈ public beta, L2 ≈ prod) via SAST (semgrep-class) + targeted authz/input/boundary pentest | critical exploitable vuln | ASVS L2 clean |
| Resilience/Perf | p95 latency vs a stated SLO + error-path & load behavior (k6-class) | falls over / no error handling | meets SLO under load, degrades gracefully |
| Product integrity | End-to-end core-user-journey pass rate via exploratory + scripted E2E on the **running app** | journeys broken | all core journeys work as a real user would experience them |

## The headline IS the conformance matrix; the 0–100 is its rollup

The primary artifact is a **conformance matrix**, not a bare number.
For each named Tier-1 standard, the app is reported
`CONFORMANT / PARTIAL / NON-CONFORMANT` against that standard's
machine-checkable control subset, with **per-control evidence**, plus
an explicit "controls requiring human/organizational audit — out of
automated scope" section (Tier 2). Example shape:

```
OWASP ASVS L2          : CONFORMANT      (evidence/…)
WCAG 2.2 AA            : CONFORMANT      (axe report)
GDPR technical controls: CONFORMANT      (encryption/deletion/logs)
SAST / CVE             : CONFORMANT      (semgrep + npm audit)
Resilience SLO         : PARTIAL         (2 endpoints over p95)
Independent AC verify  : CONFORMANT      (fresh E2E, not Archie's tests)
— Tier 2 (human audit, out of scope) —
SOC 2 Type II          : engineering controls READY; org/process
                         attestation requires a human auditor
3rd-party pen test     : not performed (recommend before prod)
score 82/100 = rollup of the above (gated)
```

The number exists only so there's a single comparable figure across
apps; its meaning is entirely derived from the matrix. "82 because
ASVS L2 + GDPR-technical + WCAG AA conformant, 2 resilience partials"
is defensible; "82" alone is not.

## Scoring is GATED, not averaged

The gates do the real work; the composite is secondary.

- **Critical security vuln (e.g. auth bypass, injection) → total capped ≤ 70**, regardless of other axes. A prod app cannot have one.
- **Does not build/boot → total capped ≤ 40.** Pretty code that doesn't run is noise-adjacent.
- Above gates: weighted composite of the five sub-scores. Weights are
  set during calibration, not asserted up front, and must be
  documented with rationale.

## Calibration protocol (LOCKED before Clarity is scored)

1. Build the harness as a **repo-agnostic runner**: input = any git
   repo + its spec/ACs; output = 5 sub-scores + gated total +
   evidence bundle. Design the scoring logic reasoning ONLY about the
   external standards and reference apps — do **not** look at
   Clarity's code while designing scoring.
2. Run on a **reputable OSS production app** of similar shape
   (React/TS/serverless). Expect ~85–90. If it doesn't land there,
   the harness is wrong — fix the harness, not the expectation.
3. Run on a **deliberately-weak/toy app**. Expect ~25–35.
4. Only if the scale behaves on both anchors: **lock the harness (no
   further edits) and score Clarity blind.** Any harness change after
   Clarity has been observed invalidates the run → recalibrate from
   step 2.

## Honest risks (on record before build)

1. **AC pass-rate is circular if measured by Archie's own tests.**
   Archie wrote Clarity's tests; "its own tests pass" is the
   gameable-test problem already seen at WOR-118. Correctness MUST be
   verified independently — fresh E2E/exploratory authored against
   the *spec*, not Archie's suite. Otherwise that dimension is
   self-graded and contaminates the whole number.
2. **Reference-app selection is load-bearing and contestable.** The
   "~85–90 expected" is itself an assumption. Calibration apps must
   be chosen carefully and the choice *documented with rationale*;
   this is where technical DD will probe.
3. **Clarity stays untouchable.** The harness is new evaluation
   infra (lives outside Clarity, runs read-only against it, never
   modifies it). Same discipline as the whole experiment.
4. **First concrete build step is a decision, not code:** selecting +
   justifying the calibration reference apps. Bring that to Josh; do
   not pick unilaterally.

## Sequencing

- NOT now. The app isn't done (last 5 tickets in flight).
- When build completes → step 1 is reference-app selection (a
  decision for Josh), then harness build, then calibrate, then score.
- This doc is the canonical design; update it append-aware (it is a
  design doc, not the immutable run journal — it may be revised, but
  record material changes with date + who/why).
