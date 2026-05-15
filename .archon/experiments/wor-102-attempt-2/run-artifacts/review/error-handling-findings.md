# Error Handling Findings: PR #14

**Reviewer**: error-handling-agent
**Date**: 2026-05-15T00:00:00Z
**Error Handlers Reviewed**: 5

---

## Summary

The PR introduces a well-structured `handleConvexError` utility that properly maps all nine Convex error codes to user-friendly messages and never leaks internal details. The route guards (`ProtectedRoute`, `AdminRoute`) handle loading and auth states correctly. There are two areas of concern: the `main.tsx` entry point performs an unsafe cast of `VITE_CONVEX_URL` without validation (could produce a runtime crash with no user-visible feedback), and the `AdminRoute` does not distinguish between a `null` user (no matching DB row) and a query error — both silently redirect to `/dashboard`.

**Verdict**: NEEDS_DISCUSSION

---

## Findings

### Finding 1: Unsafe VITE_CONVEX_URL cast with no validation

**Severity**: MEDIUM
**Category**: silent-failure
**Location**: `src/main.tsx:8`

**Issue**:
`import.meta.env.VITE_CONVEX_URL` is cast to `string` via `as string` without any runtime check. If the env var is missing or empty, `ConvexReactClient` receives `undefined` cast to a string, which will throw a cryptic runtime error deep inside the Convex SDK — with no user-visible feedback.

**Evidence**:
```typescript
// Current code at src/main.tsx:8
const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);
```

**Hidden Errors**:
This pattern could silently hide:
- **Missing `.env.local`**: Developer forgets to create the file; app crashes on load with an opaque SDK error
- **Empty string**: Env var exists but is blank; SDK may attempt to connect to an invalid URL
- **Typo in var name**: e.g. `CONVEX_URL` instead of `VITE_CONVEX_URL` — silently `undefined`

**User Impact**:
App fails to render entirely. The user sees a blank white page with no indication of what went wrong. Developers debugging this locally waste time tracing through SDK internals.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Add a runtime guard that throws a clear error if the env var is missing | Immediate, clear DX error message | Only helps developers, not end users |
| B | Add guard + render a fallback UI component | Better UX for deployed misconfiguration | Slightly more code |
| C | Leave as-is (trust deployment pipeline) | Zero code change | Poor DX; silent failure in local dev |

**Recommended**: Option A

**Reasoning**:
This is a developer-facing configuration error, not a user-facing runtime issue. A clear `throw new Error(...)` at startup is the standard Vite pattern and provides an immediate, actionable message. End users will never see this because deployment pipelines set the var. This aligns with the "validate at system boundaries" principle.

**Recommended Fix**:
```typescript
const convexUrl = import.meta.env.VITE_CONVEX_URL;
if (!convexUrl) {
  throw new Error("Missing VITE_CONVEX_URL environment variable");
}
const convex = new ConvexReactClient(convexUrl);
```

---

### Finding 2: AdminRoute conflates null-user with non-admin — silent redirect

**Severity**: LOW
**Category**: unsafe-fallback
**Location**: `src/components/layout/AdminRoute.tsx:33`

**Issue**:
When `useQuery(api.users.me)` returns `null` (authenticated user has no matching row in the `users` table), the guard silently redirects to `/dashboard` — the same behavior as for a non-admin user. This is correct for the "non-admin" case but masks a data integrity issue (authenticated user missing from DB).

**Evidence**:
```typescript
// Current code at src/components/layout/AdminRoute.tsx:33
if (!user || user.role !== "ADMIN") {
  return <Navigate to="/dashboard" replace />;
}
```

**Hidden Errors**:
This condition could silently hide:
- **Missing user row**: User authenticated via Convex Auth but no corresponding `users` table entry exists (signup race condition, failed migration)
- **Database query error**: Although Convex suspends on errors rather than returning null, future changes to the `me` query could alter this behavior

**User Impact**:
An authenticated admin whose DB record is missing gets silently bounced to the dashboard with no error message. They cannot diagnose why they lack admin access. This is an edge case — during normal operation the user row always exists.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Separate `!user` (show error/log) from `user.role !== "ADMIN"` (redirect) | Distinguishes data bug from authorization | Slightly more code |
| B | Leave as-is (null user is a marginal edge case) | Simple; the redirect is safe | Masks data integrity issues |

**Recommended**: Option B (for now)

**Reasoning**:
This is a stub/scaffold PR. The `users.me` query returns `null` only if the user row is genuinely absent, which is a backend data integrity issue — not something the frontend route guard should own. Convex query errors throw (suspense boundary), so there's no risk of masking SDK errors. Splitting the conditions adds complexity without clear benefit at this stage. Worth revisiting when real admin functionality lands.

---

### Finding 3: handleConvexError swallows original error context

**Severity**: LOW
**Category**: missing-logging
**Location**: `src/lib/errorHandler.ts:18-27`

**Issue**:
`handleConvexError` maps errors to user-friendly messages but does not log the original error anywhere. Call sites that use this utility to display toast messages will lose the original stack trace and error details unless they separately log the error before calling the handler.

**Evidence**:
```typescript
// Current code at src/lib/errorHandler.ts:18-27
export function handleConvexError(error: unknown): ErrorMessage {
  if (error instanceof ConvexError) {
    const data = error.data as { code?: string };
    if (data && typeof data.code === "string" && data.code in USER_MESSAGES) {
      const code = data.code as ErrorCode;
      return { code, message: USER_MESSAGES[code] };
    }
  }
  return { code: "INTERNAL", message: "Something went wrong. Please try again." };
}
```

**Hidden Errors**:
- **Non-ConvexError exceptions**: Any error that isn't a `ConvexError` maps to a generic "INTERNAL" without any logging — the original error, stack trace, and context are discarded
- **ConvexError with unrecognized code**: Falls through to generic without logging the unexpected code value

**User Impact**:
Minimal direct user impact (they get the generic message). The real impact is on debugging: when a call site does `const { message } = handleConvexError(err); showToast(message);` the original error is lost unless the caller also logs it.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Add `console.error(error)` inside the function for non-ConvexError and unknown-code paths | Ensures errors are always captured in browser console | Couples logging to the utility |
| B | Keep utility pure; document that callers must log before calling | Clean separation of concerns | Easy to forget at call sites |
| C | Return the original error alongside the message for callers to log | Most flexible | Changes return type; more refactoring |

**Recommended**: Option B (for now)

**Reasoning**:
The utility is intentionally a pure mapping function (error in → message out). Adding side effects like `console.error` would make it harder to test and reuse. The docs at `docs/errors.md` already show the recommended call-site pattern (`try/catch` → `handleConvexError` → toast). Logging responsibility belongs to call sites or a future global error boundary. This is appropriate for a scaffold PR — logging infrastructure can be added when real mutations land.

---

## Error Handler Audit

| Location | Type | Logging | User Feedback | Specificity | Verdict |
|----------|------|---------|---------------|-------------|---------|
| `src/lib/errorHandler.ts:18` | type-check + fallback | N/A (pure mapper) | GOOD | GOOD | PASS |
| `src/main.tsx:8` | `as string` cast | NONE | NONE | BAD | FAIL |
| `src/components/layout/ProtectedRoute.tsx:7-16` | conditional render | N/A | GOOD (loading + redirect) | GOOD | PASS |
| `src/components/layout/AdminRoute.tsx:13-34` | conditional render | N/A | GOOD (loading + redirect) | GOOD | PASS |
| `src/components/layout/AdminRoute.tsx:33` | null-check fallback | NONE | Redirect only | MEDIUM | PASS |

---

## Statistics

| Severity | Count | Auto-fixable |
|----------|-------|--------------|
| CRITICAL | 0 | 0 |
| HIGH | 0 | 0 |
| MEDIUM | 1 | 1 |
| LOW | 2 | 2 |

---

## Silent Failure Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Missing VITE_CONVEX_URL → blank page | MED (local dev) | HIGH (app won't render) | Add runtime guard in main.tsx |
| Admin user with no DB row → silent redirect | LOW | LOW (edge case) | Separate null-user check (future PR) |
| Call site swallows error without logging | MED (future code) | MED (lost debug context) | Document logging responsibility |

---

## Patterns Referenced

| File | Lines | Pattern |
|------|-------|---------|
| `src/lib/errorHandler.ts` | 18-27 | Pure error-to-message mapper with instanceof check and fallback |
| `convex/lib/errors.ts` | — | Centralized `appError()` factory with typed error codes |
| `src/components/layout/ProtectedRoute.tsx` | 4-20 | Loading → auth check → redirect/render pattern |
| `src/components/layout/AdminRoute.tsx` | 6-38 | Auth check → query → role check → redirect/render pattern |

---

## Positive Observations

- **`handleConvexError` is well-designed**: Covers all 9 error codes, provides specific user-friendly messages, never leaks internal details, handles edge cases (null, undefined, string, plain Error). Thorough test coverage in `tests/unit/errorHandler.test.ts`.
- **Route guards handle loading states properly**: Both `ProtectedRoute` and `AdminRoute` show accessible loading indicators (with `role="status"` and `aria-label`) during async operations, preventing flash-of-wrong-content.
- **AdminRoute correctly skips the query when unauthenticated**: `isAuthenticated ? {} : "skip"` prevents unnecessary DB queries, which is the idiomatic Convex pattern.
- **User-facing messages are actionable**: Each mapped message tells the user what to do ("Please sign in", "Please refresh and try again", "Please wait a moment").

---

## Metadata

- **Agent**: error-handling-agent
- **Timestamp**: 2026-05-15T00:00:00Z
- **Artifact**: `/home/user/.archon/workspaces/joshuarossi/Clarity/artifacts/runs/03c9d80c1026d975363261233508c436/review/error-handling-findings.md`
