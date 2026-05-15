# Fix Report: PR #14

**Date**: 2026-05-15T03:00:00Z
**Branch**: archon/task-wor-102
**Commit**: c59e3645e4e226204a2d8dfc0c37ae2ef2379fbf

---

## Fixes applied (7)

| Severity | Issue | Location | What changed |
|----------|-------|----------|--------------|
| HIGH | Non-null assertion on `identity.email` could fail with non-email auth providers | `convex/users.ts:10-12` | Removed `!` assertion; added early `return null` guard when `identity.email` is undefined |
| HIGH | Provider nesting in docs/contract doesn't match actual code (describes separate `<ConvexProvider>` wrapper) | `docs/app-shell.md:11-17`, `docs/contracts/wor-102.md:53,84,139,186` | Updated all references to reflect that `<ConvexAuthProvider>` wraps `ConvexProvider` internally |
| MEDIUM | `VITE_CONVEX_URL` cast to `string` with no runtime validation — blank page on missing env var | `src/main.tsx:8` | Added runtime guard that throws a clear error message when env var is missing |
| LOW | Login route redirects authenticated users during loading state, causing flash | `src/App.tsx:95` | Added `!isLoading` check before auth redirect on `/login` route |
| LOW | Duplicated loading spinner markup across ProtectedRoute and AdminRoute (3 instances) | `src/components/layout/ProtectedRoute.tsx`, `src/components/layout/AdminRoute.tsx` | Extracted shared `LoadingSpinner` component into `src/components/layout/LoadingSpinner.tsx` |
| LOW | AdminRoute conflates null-user (no DB record) with non-admin into single check | `src/components/layout/AdminRoute.tsx:33` | Split `!user \|\| user.role !== "ADMIN"` into separate `null` and role checks for clearer control flow |
| LOW | `handleConvexError` intentionally swallows original error context but this isn't documented | `src/lib/errorHandler.ts:18` | Added JSDoc explaining the design choice and that callers should log before calling |

---

## Deferred (questions for human review) (0)

No findings were categorized as questions — all were actionable issues.

---

## Deferred (pipeline-restricted) (2)

| Severity | Issue | Location | Reason |
|----------|-------|----------|--------|
| MEDIUM | E2E spec references `data-testid='dashboard-page'` but stub uses `page-dashboard` | `e2e/app-shell.spec.ts:584` | Test files are owned by a separate pipeline step |
| LOW | Outdated red-state comments in spec files | `e2e/app-shell.spec.ts:448`, `errorHandler.test.ts:1437` | Test files are owned by a separate pipeline step |
