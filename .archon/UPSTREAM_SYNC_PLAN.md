# Upstream Sync Plan — joshuarossi/Archon ↔ coleam00/Archon

**When to read this:** before merging upstream changes into this fork. Captures the state of the divergence as of 2026-05-08, the behavior-contract risk assessment for each upstream change, and the merge recipe. Hold off on executing the merge until you've decided on the `settingSources` mitigation.

**Status:** Hold. Not merging now. Document captures current state for when you're ready.

---

## Current divergence

| | commit | date |
|---|---|---|
| Your `main` | `81796b70` | 2026-05-07 |
| `upstream/main` | `fd6d75e7` (v0.3.10 homebrew bump) | 2026-04-29 |
| `upstream/dev` | `f4f27255` (roadmap page) | recent |
| Merge base (your `main` ↔ `upstream/dev`) | `8295ece7` | 2026-04-30 |

- Your `main` is **0 commits behind** `upstream/main`, and **68 commits ahead** of `upstream/dev` (those 68 are your fork-specific work — Jira adapter, task-implement DAG, Archie scripts, the script-based PreToolUse hooks patch, the CLAUDE.md rewrite, etc).
- `upstream/dev` is **17 commits ahead** of your `main`. These are the 17 candidates for merging.
- `upstream/main` has not received a release since 2026-04-29 (v0.3.10). The 17 commits are sitting on `upstream/dev` waiting for the next release cut.

---

## What's in the 17 upstream commits

Categorized by relevance to Archie:

### Behavior-contract changes (read carefully before merging)

#### `ee8fcbf0` — fix(workflows): substitute array/object node output fields as JSON

**File:** `packages/workflows/src/dag-executor.ts:307` (7-line diff)

**Before:** `$nodeId.output.<arrayOrObject>` substituted as empty string. Documented bug.

**After:** `$nodeId.output.<arrayOrObject>` substituted as JSON-stringified value (shell-escaped if used in a bash context).

**Impact on Archie:** **positive.** Archie's scripts that read structured outputs from upstream nodes can now consume JSON via `jq` / `JSON.parse` directly, instead of the current pattern of "stringify it yourself in the upstream node, write to a file, read the file downstream." The string/number/boolean substitution paths are unchanged.

**Risk:** if any Archie YAML or script uses `[ -z "$node.output.array" ]` to mean "no array provided," that check now flips (an array now produces `'[]'` or `'[...]'`, not empty). Audit before merge: `grep -rE '\$\w+\.output\.\w+' .archon/` and check whether any of those refs point at an array/object source and rely on the previous empty-string behavior. Almost certainly no current usages depend on this; structured outputs are passed via files in Archie per `feedback_files_not_envs_between_nodes`.

#### `912be113` — feat(docker): persist /home/appuser by default + clarify ARCHON_HOME/ARCHON_DATA semantics

**File:** `packages/providers/src/claude/provider.ts:622` (1-line behavior change in addition to the Docker work)

**Before:** Claude default `settingSources = ['project']`. Only project-level CLAUDE.md is loaded into the SDK's context.

**After:** Claude default `settingSources = ['project', 'user']`. Both project-level *and* user-level (`~/.claude/CLAUDE.md`) are loaded by default. Opt-out is to set `settingSources: ['project']` explicitly in `.archon/config.yaml`.

**Impact on Archie:** **medium-to-high risk.** After this merge, every Claude invocation in every Archie workflow node — reviewer, dev, test-gen, synthesizer, evaluator, decomposition advisers — would inherit `~/.claude/CLAUDE.md` content. This conflicts with the "single-purpose agent prompts" rule (`feedback_single_purpose_agent_prompts`): each Archie agent should see only its task brief, not your machine-wide preferences and current project context.

**Mitigation (action item before/with merge):** add the explicit opt-out to Archie's config:

```yaml
# .archon/config.yaml
assistants:
  claude:
    settingSources: [project]    # explicit opt-out — Archie agents must not inherit ~/.claude/CLAUDE.md
```

This can (and should) be added **before** the merge — it's a no-op against the current code (current default is already `['project']`) and locks in the contract for after the merge. Pre-merging it makes the merge step itself a non-event for this concern.

#### `8295ece7` — fix(workflows): stop sweeping scratch artifacts from every git add -A site

**Files:** 12 bundled command/workflow defaults under `.archon/commands/defaults/` and `.archon/workflows/defaults/`. **Does not touch `dag-executor.ts`** despite the commit being identified as the merge base.

**Before:** Several upstream-bundled commands (`archon-create-pr`, `archon-finalize-pr`, `archon-fix-issue`, `archon-implement-issue`, `archon-implement-review-fixes`, `archon-simplify-changes`, etc.) used `git add -A` to stage commit content. This swept untracked review/report files in the worktree — including scratch artifacts written there by upstream review nodes — into commits.

**After:** Those commands now stage explicit files instead of `git add -A`, and write scratch artifacts to `$ARTIFACTS_DIR` rather than the worktree.

**Impact on Archie:** **no direct impact.** Archie's `task-implement` uses the *forked* versions of these commands (your `task-implement-fixes.md`, your task-* workflows), not upstream's. The merge will not change Archie's runtime behavior.

**Indirect lesson worth applying:** Archie's own commands and scripts should follow the same principle — never `git add -A` in a workflow node. Audit `.archon/commands/*.md` and `.archon/scripts/*` for `git add -A` usage and replace with explicit-file staging or `$ARTIFACTS_DIR` redirection. Track this as a follow-up Mode 2 item, **separate from the merge** — don't bundle it.

### Pure feature additions (low-risk, high-value)

| Commit | Summary | Notes |
|---|---|---|
| `5e61faf0` | feat(cli): setup overhaul + `archon doctor` + complete bundled skill | Diagnostic tool you don't have. Pure additive. |
| `4631b8e0` | feat(cli): `archon skill install` | Skill management CLI. Pure additive. |
| `f4f27255` | feat(docs): public roadmap at `/roadmap` | Docs-site only. No engine impact. |
| `342685ee` | feat(maintainer): Pi/Minimax variant of repo-triage | Bundled workflow add. |

### Pi provider improvements

| Commit | Summary | Notes |
|---|---|---|
| `79a25817` | Pi: load user settings files as session baseline | Only matters if Archie uses Pi. |
| `d3bda4bd` | fix(pi): surface SDK error messages, cap concurrency | Only matters if Archie uses Pi. |

(Open question: does Archie use Pi anywhere? If not, these two are no-ops for the merge. If yes, both are wins.)

### Bug fixes (safe to take)

| Commit | Summary |
|---|---|
| `0c5d7b12` | fix(orchestrator): create `~/.archon/workspaces` before AI provider spawn |
| `e33e0de6` | fix(workflows): `archon-assist` runs in live checkout (worktree.enabled: false) |
| `5593498c` | fix(workflows): prevent zombie runs from hung Pi cleanup |
| `0ec74410` | fix(deps): bump hono to ^4.12.16 + @hono/node-server ^1.19.13 |
| `88d01099` | fix(cli): handle `--version`, `-V`, `-version`, lone `-v` |
| `69b2c897` | fix(docker): resolve Claude binary to glibc variant on Debian |

### Docs

| Commit | Summary |
|---|---|
| `41c0f179` | docs(direction): forge-agnostic support direction |
| `1820a358` | docs(release-skill): warn against `--ff-only` and `reset --hard` for dev/main sync |

---

## Conflict-zone files

Of the 75 files touched by the 17 upstream commits and the 41 files modified by your fork's 68 commits, only **5 files** appear in both sets:

| File | Resolution |
|---|---|
| `CLAUDE.md` | Take yours. We just rewrote it as a 154-line bootstrap spine; upstream changes are minor inline yaml comment updates around `settingSources` examples. |
| `.env.example` | Take both. Dedupe new env keys. |
| `packages/providers/src/claude/provider.ts` | Take upstream's `settingSources` flip. Mitigate by setting `settingSources: ['project']` in `.archon/config.yaml` (see action item above). |
| `packages/workflows/src/dag-executor.ts` | Three-way merge cleanly. Your `bca886d3` patch (script-based PreToolUse hooks) touches lines 75, 338, 441–460 in `resolveNodeProviderAndModel`. Upstream's `ee8fcbf0` patch touches line 307 in `substituteNodeOutputRefs`. **No textual or behavioral overlap.** |
| `packages/workflows/src/defaults/bundled-defaults.generated.ts` | Don't hand-merge. After the rest of the merge resolves, run `bun run generate:bundled` to regenerate from the merged source files. |

No other engine files (the schemas under `packages/workflows/src/schemas/`, the validator, the server routes, the config layer) were touched by upstream, so your patches in those areas are stable across the merge.

---

## Pre-merge action items

These can be done **before** the merge, independently:

1. **Add `settingSources: [project]` to `.archon/config.yaml`** under `assistants.claude`. No-op today, locks in the contract for after the merge. Single line. **High priority.**
2. **Audit Archie commands and scripts for `git add -A` usage**: `grep -rE '\bgit\s+add\s+-A\b' .archon/commands/ .archon/scripts/ .archon/workflows/`. Replace with explicit-file staging where found. Separate Mode 2 PR. **Medium priority — relevant lesson, not blocking.**
3. **Audit Archie YAML and scripts for `$node.output.<field>` references**: confirm none rely on the empty-string-for-array/object behavior that `ee8fcbf0` changes. Almost certainly clean given the files-not-env discipline, but worth a one-line `grep` to confirm. **Low priority — almost certainly a non-issue.**
4. **Decide whether Archie uses Pi.** If yes, the two Pi fixes (`79a25817`, `d3bda4bd`) are valuable; if not, they're noise. Either way the merge is safe; the question only affects how you frame the value.

---

## Merge recipe (when ready to execute)

```bash
# 1. Branch from your main
cd /home/user/Archon
git checkout main
git pull origin main
git checkout -b chore/upstream-sync-2026-05-08

# 2. Make sure pre-merge action items are done
#    - settingSources opt-out in .archon/config.yaml committed to main first

# 3. Fetch and merge upstream/dev
git fetch upstream
git merge upstream/dev

# 4. Resolve the 5 conflict files
#    - CLAUDE.md                                            → keep ours
#    - .env.example                                         → take both, dedupe
#    - packages/providers/src/claude/provider.ts            → take upstream's settingSources flip
#    - packages/workflows/src/dag-executor.ts               → three-way merges cleanly
#    - packages/workflows/src/defaults/bundled-defaults.generated.ts
#                                                           → don't hand-merge; regenerate after

# 5. Regenerate bundled defaults
bun run generate:bundled

# 6. Run the full validation suite
bun run validate

# 7. Smoke-test Archie end-to-end before merging the merge PR
#    - run task-tests + task-implement on a synthetic ticket against ConflictCoach
#    - confirm no regression in $node.output substitution behavior
#    - confirm no leak of ~/.claude/CLAUDE.md into agent prompts (verify settingSources opt-out works)

# 8. PR
gh pr create --base main --head chore/upstream-sync-2026-05-08 \
  --title "chore: sync upstream/dev (17 commits, 2026-04-30 → 2026-05-08)" \
  --body "..."  # use the PR template; reference this doc
```

---

## Rollback plan

If post-merge smoke testing reveals regressions:

1. **Identifiable single-commit cause:** revert that commit on the merge branch with `git revert <sha> -m 1` and re-PR.
2. **Systemic regression:** abandon the merge branch, do not merge into main. The merge branch is local-only until step 8 above. Rolling back is `git checkout main && git branch -D chore/upstream-sync-2026-05-08`.
3. **Already merged into main and regression discovered after:** revert the merge commit. Branch protection should support `git revert -m 1 <merge-sha>`. Push the revert as its own PR.

---

## Open questions

1. **Does Archie use Pi anywhere?** Affects the value calculation for the two Pi commits but not the merge mechanics.
2. **Is there appetite for a `git add -A` audit as a follow-up?** Separate from the merge but informed by the same upstream lesson.
3. **What's our threshold for taking another upstream sync vs. waiting?** The 17-commit batch is small. Waiting longer means more divergence, more conflict surface, and more behavior-contract changes to evaluate at once. Worth establishing a cadence (e.g. "merge upstream when the diff exceeds 30 commits or 30 days, whichever comes first").

---

## Document maintenance

Update this doc when:
- The merge actually happens (mark sections as resolved, link to the merge PR).
- New upstream commits land and the divergence count changes meaningfully (re-run the conflict-zone analysis if your fork also touched new files in the meantime).
- A new behavior-contract change appears in upstream (the `settingSources` flip class of change is the kind to flag here).

If this doc gets stale (more than ~2 weeks past its date stamp without an update), regenerate the divergence numbers and the contract assessment from scratch rather than trying to extend the existing analysis.

_Last updated: 2026-05-08 by Claude + Josh during CLAUDE.md/docs cleanup session._
