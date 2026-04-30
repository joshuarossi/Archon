#!/usr/bin/env bash
#
# Deterministic validation runner — invoked between dev-loop iterations as
# the loop's until_bash. Runs lint, typecheck, scoped Vitest, scoped Playwright.
# Always writes $ARTIFACTS_DIR/test-report.json so the next dev iteration can
# read it and know what to fix.
#
# Exit code: 0 if all applicable gates pass (loop ends), 1 otherwise (loop
# continues with the dev agent reading the fresh report).
#
# Required env (set by the workflow's prepared environment):
#   ARTIFACTS_DIR  — workflow's artifacts directory
#   ISSUE_KEY      — Jira ticket key (selects which test scope to run)
#
set -uo pipefail

# Redirect ALL of this script's narrative output (gate banners, tail dumps,
# pass/fail markers) to stderr, leaving stdout for the single trailing JSON
# line. The bash node's stdout is what gets captured into the workflow's
# nodeOutput; downstream `when:` clauses parse it as JSON, so any prose on
# stdout makes JSON.parse fail and the condition evaluates to ''.
exec 3>&1 1>&2

ARTIFACTS_DIR="${ARTIFACTS_DIR:?ARTIFACTS_DIR not set}"
ISSUE_KEY="${ISSUE_KEY:?ISSUE_KEY not set}"

# Resolve the per-ticket test directory case-insensitively. The Jira key is
# uppercase (WOR-23) but test-gen agents have scaffolded tests under both
# tests/WOR-23/ and tests/wor-23/ on different runs; rather than fight that,
# locate whichever exists. Falls back to the lowercase form if neither
# exists, so the SKIP message is consistent.
find_ticket_dir() {
  local parent="$1"
  local key_lc key_uc
  key_lc=$(echo "$ISSUE_KEY" | tr '[:upper:]' '[:lower:]')
  key_uc=$(echo "$ISSUE_KEY" | tr '[:lower:]' '[:upper:]')
  if [ -d "$parent/$ISSUE_KEY" ]; then echo "$parent/$ISSUE_KEY"
  elif [ -d "$parent/$key_lc" ]; then echo "$parent/$key_lc"
  elif [ -d "$parent/$key_uc" ]; then echo "$parent/$key_uc"
  else echo "$parent/$key_lc"  # fallback for the SKIP message
  fi
}

VITEST_DIR=$(find_ticket_dir tests)
PLAYWRIGHT_DIR=$(find_ticket_dir e2e)

mkdir -p "$ARTIFACTS_DIR/test-results"
REPORT="$ARTIFACTS_DIR/feedback.json"

# Build the gates list incrementally as a JSON string.
GATES_JSON="[]"

add_gate() {
  local name="$1" status="$2" log_file="$3"
  GATES_JSON=$(NAME="$name" STATUS="$status" LOG_FILE="$log_file" GATES_JSON="$GATES_JSON" bun -e '
    import { readFileSync } from "node:fs";
    const gates = JSON.parse(process.env.GATES_JSON || "[]");
    let log = "";
    try { log = readFileSync(process.env.LOG_FILE, "utf8"); } catch {}
    // Cap each gate log at 8000 chars (last bytes — failure tail is what matters).
    gates.push({
      name: process.env.NAME,
      status: process.env.STATUS,
      log: log.length > 8000 ? log.slice(-8000) : log,
    });
    console.log(JSON.stringify(gates));
  ')
}

run_gate() {
  local name="$1" cmd="$2"
  local log_file="$ARTIFACTS_DIR/test-results/${name}.log"

  echo "──────────────────────────────────────────────────────────────────"
  echo "GATE: $name"
  echo "──────────────────────────────────────────────────────────────────"
  bash -c "$cmd" > "$log_file" 2>&1
  local rc=$?
  if [ $rc -eq 0 ]; then
    echo "✓ $name PASSED"
    add_gate "$name" "passed" "$log_file"
    return 0
  else
    echo "✗ $name FAILED (exit $rc). Last 40 lines of output:"
    tail -40 "$log_file" | sed 's/^/  /'
    add_gate "$name" "failed" "$log_file"
    return 1
  fi
}

skip_gate() {
  local name="$1" reason="$2"
  echo "── SKIP: $name ($reason) ──"
  add_gate "$name" "skipped" "/dev/null"
}

has_script() {
  local script_name="$1"
  if [ ! -f package.json ]; then
    return 1
  fi
  bun -e "
    import { readFileSync } from 'node:fs';
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    process.exit(pkg.scripts && pkg.scripts['$script_name'] ? 0 : 1);
  " 2>/dev/null
}

OVERALL=0

# 1. Lint
if has_script lint; then
  run_gate "lint" "npm run lint" || OVERALL=1
else
  skip_gate "lint" "no script in package.json"
fi
echo

# 2. Typecheck
if has_script typecheck; then
  run_gate "typecheck" "npm run typecheck" || OVERALL=1
else
  skip_gate "typecheck" "no script in package.json"
fi
echo

# 3. Vitest scoped to this ticket's tests (case-insensitive dir resolution)
if [ -d "$VITEST_DIR" ]; then
  run_gate "vitest" "npx vitest run $VITEST_DIR --reporter=default" || OVERALL=1
else
  skip_gate "vitest" "$VITEST_DIR/ does not exist"
fi
echo

# 4. Playwright scoped to this ticket's specs
if [ -d "$PLAYWRIGHT_DIR" ]; then
  run_gate "playwright" "npx playwright test $PLAYWRIGHT_DIR --reporter=line" || OVERALL=1
else
  skip_gate "playwright" "$PLAYWRIGHT_DIR/ does not exist"
fi
echo

# Write the final structured report. Dev agent's next iteration reads this.
OVERALL_STATUS=$([ $OVERALL -eq 0 ] && echo passed || echo failed)
ISSUE_KEY="$ISSUE_KEY" OVERALL_STATUS="$OVERALL_STATUS" GATES_JSON="$GATES_JSON" REPORT="$REPORT" bun -e '
  import { writeFileSync } from "node:fs";
  const report = {
    issue_key: process.env.ISSUE_KEY,
    overall: process.env.OVERALL_STATUS,
    gates: JSON.parse(process.env.GATES_JSON),
    generated_at: new Date().toISOString(),
  };
  writeFileSync(process.env.REPORT, JSON.stringify(report, null, 2));
  console.log(`Test report written: ${process.env.REPORT}`);
'

echo "══════════════════════════════════════════════════════════════════"
if [ $OVERALL -eq 0 ]; then
  echo "✓ ALL GATES PASSED for $ISSUE_KEY"
  echo "══════════════════════════════════════════════════════════════════"
  # Final JSON goes to the saved real stdout (fd 3) so it's the ONLY thing
  # downstream `when:` clauses see. Narrative is on stderr (fd 2).
  printf '{"passed":"true","issue_key":"%s","report":"%s"}\n' "$ISSUE_KEY" "$REPORT" >&3
else
  echo "✗ GATE(S) FAILED for $ISSUE_KEY — feedback.json written; next dev attempt will read it."
  echo "══════════════════════════════════════════════════════════════════"
  printf '{"passed":"false","issue_key":"%s","report":"%s"}\n' "$ISSUE_KEY" "$REPORT" >&3
fi
# Always exit 0. The DAG's `when:` clauses gate on the JSON output's passed field,
# not on the exit code. This lets downstream conditional nodes route on test
# outcome without the validation node itself being "failed" in DAG terms.
exit 0
