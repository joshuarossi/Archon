# Error Handling Findings: PR #13

**Reviewer**: error-handling-agent
**Date**: 2026-05-14T00:00:00Z
**Error Handlers Reviewed**: 5

---

## Summary

This PR introduces a well-structured frontend error handler utility (`handleConvexError`) with comprehensive code-to-message mapping and solid fallback behavior. Error handling across the PR is minimal overall — most files are stub route pages or provider wiring with no explicit try/catch blocks. The main concerns are: (1) a non-null assertion on `identity.email` in the Convex `users.me` query that could throw at runtime, (2) the `handleConvexError` utility is defined but never wired into any call site in this PR, and (3) the `AdminRoute` component silently renders `<Outlet />` when the user query returns `null` (authenticated user not in the `users` table), which could let unauthorized users through.

**Verdict**: NEEDS_DISCUSSION

---

## Findings

### Finding 1: Non-null assertion on `identity.email` in `convex/users.ts`

**Severity**: HIGH
**Category**: silent-failure
**Location**: `convex/users.ts:13`

**Issue**:
The query uses `identity.email!` (non-null assertion) when looking up the user by email. If a Convex auth identity lacks an email (e.g., phone-based auth, certain OAuth providers), this will pass `undefined` to the index query, which could return unexpected results or throw a runtime error in the Convex backend.

**Evidence**:
```typescript
// Current code at convex/users.ts:11-14
const user = await ctx.db
  .query("users")
  .withIndex("by_email", (q) => q.eq("email", identity.email!))
  .unique();
```

**Hidden Errors**:
This assertion could silently hide:
- **Missing email on identity**: OAuth providers that don't supply email would cause `identity.email` to be `undefined`, and the `!` assertion bypasses TypeScript's null check
- **Index query on undefined**: Passing `undefined` to `q.eq("email", ...)` could return no results (silent null) or throw, depending on Convex runtime behavior
- **Wrong user lookup**: If Convex coerces undefined, it could match unexpected records

**User Impact**:
An authenticated user whose identity has no email would get `null` from the `me` query. In `AdminRoute`, this means `user` is `null`, so the `user.role !== "ADMIN"` check is skipped (see Finding 3). In `TopNav`, they'd see "User" as their display name — degraded but not broken.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Guard: return `null` if `!identity.email` | Safe, explicit, consistent with auth-not-found | Users without email can't be looked up |
| B | Throw `appError("UNAUTHENTICATED", ...)` if `!identity.email` | Surfaces the issue; callers know something is wrong | Harsher UX for edge-case auth providers |
| C | Look up by `identity.tokenIdentifier` instead of email | Works for all auth types | Requires schema index change |

**Recommended**: Option A

**Reasoning**:
This is an app shell PR focused on wiring, not auth strategy. A simple guard aligns with the existing pattern (return `null` when identity is absent) and avoids introducing runtime errors. The auth lookup strategy can be refined in a dedicated auth task.

**Recommended Fix**:
```typescript
const identity = await ctx.auth.getUserIdentity();
if (!identity || !identity.email) {
  return null;
}
```

---

### Finding 2: `handleConvexError` is defined but never called

**Severity**: MEDIUM
**Category**: missing-logging
**Location**: `src/lib/errorHandler.ts:19`

**Issue**:
The `handleConvexError` function is implemented and thoroughly tested, but no component or hook in this PR actually calls it. There is no global error boundary, no `.catch()` handler, and no `try/catch` block anywhere in the frontend code. Convex query/mutation errors will propagate as unhandled React errors with no user-friendly messaging.

**Evidence**:
```typescript
// src/lib/errorHandler.ts is exported but grep across src/ shows zero imports:
// No try/catch blocks, no .catch() handlers, no console.error calls in any src/ file
```

**Hidden Errors**:
Without wiring, the following would be unhandled:
- **Convex query failures**: Network errors, server-side exceptions from queries like `users.me` would cause React rendering errors
- **Mutation errors**: When mutations are added to stub pages, errors would be uncaught
- **ConvexError codes**: The carefully mapped error messages would never reach users

**User Impact**:
When a Convex backend error occurs, users would see a white screen or React's default error fallback instead of a friendly toast message. The error handler utility exists but provides zero value until wired in.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Add a React ErrorBoundary at the provider level that uses `handleConvexError` | Catches render-time errors globally | Doesn't catch async/mutation errors |
| B | Defer wiring to a later task (e.g., when toast system is built) | Keeps this PR focused on shell | Error handler remains dead code |
| C | Add a comment/TODO indicating the wiring is planned | Documents intent | Still dead code |

**Recommended**: Option B

**Reasoning**:
The scope notes indicate this is a shell/skeleton PR. The error handler utility is correctly implemented per the AC ("Frontend error handler utility maps ConvexError codes to user-friendly toast messages"). The actual toast integration is a natural follow-up when toast UI is built. This is intentionally staged work, not an oversight.

---

### Finding 3: `AdminRoute` allows access when user query returns `null`

**Severity**: HIGH
**Category**: unsafe-fallback
**Location**: `src/components/auth/AdminRoute.tsx:21`

**Issue**:
When an authenticated user's `users.me` query returns `null` (user exists in auth but not in the `users` table), the condition `user && user.role !== "ADMIN"` evaluates to `false` (because `user` is `null`), so the redirect to `/dashboard` is skipped, and `<Outlet />` is rendered. This means an authenticated user without a `users` table entry can access admin routes.

**Evidence**:
```typescript
// src/components/auth/AdminRoute.tsx:21-24
if (user && user.role !== "ADMIN") {
  return <Navigate to="/dashboard" replace />;
}

return <Outlet />;
```

**Hidden Errors**:
This fallback could silently hide:
- **Missing user record**: A newly authenticated user whose record hasn't been created in the `users` table yet would bypass the admin check
- **Deleted user record**: If a user's record is removed from the DB but auth session persists, they'd have admin access
- **Race condition**: Between auth completion and user record creation, there's a window where `user` is `null`

**User Impact**:
A non-admin authenticated user without a `users` table record could access admin pages (`/admin/templates`, `/admin/templates/:id`, `/admin/audit`). While these are stubs now, this is a security-relevant authorization bypass that would persist as real admin functionality is added.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Invert logic: only allow if `user?.role === "ADMIN"`, redirect otherwise | Deny-by-default; secure | Users with missing records are redirected |
| B | Add explicit `!user` check that redirects to `/dashboard` | Clear intent, handles null case | Two separate redirect conditions |
| C | Show loading/spinner while `user` is `null` (not just `undefined`) | Waits for user record to exist | Could spin forever if record never created |

**Recommended**: Option A

**Reasoning**:
Deny-by-default is the correct authorization pattern. If the user record is missing or doesn't have the ADMIN role, they should not access admin routes. This is a one-line change that closes the authorization gap.

**Recommended Fix**:
```typescript
if (!isAuthenticated) {
  return <Navigate to="/login" replace />;
}

if (user?.role !== "ADMIN") {
  return <Navigate to="/dashboard" replace />;
}

return <Outlet />;
```

Note: This requires adjusting the loading check to ensure we don't redirect while the user query is still loading (the existing `userLoading` guard handles this — when `user` is `undefined`, `userLoading` is `true` and the spinner shows).

---

### Finding 4: `ConvexReactClient` initialized with unvalidated env var

**Severity**: LOW
**Category**: silent-failure
**Location**: `src/lib/convex.ts:3`

**Issue**:
The Convex client is initialized with `import.meta.env.VITE_CONVEX_URL as string`. If this env var is missing or empty, the cast to `string` will pass `undefined` as a string to `ConvexReactClient`, which may fail with an opaque error at runtime rather than a clear developer-facing message.

**Evidence**:
```typescript
// src/lib/convex.ts:3-4
export const convex = new ConvexReactClient(
  import.meta.env.VITE_CONVEX_URL as string,
);
```

**Hidden Errors**:
- **Missing env var at dev time**: Developer gets a cryptic Convex connection error instead of "VITE_CONVEX_URL is not set"
- **Empty string**: Could cause a network error that's hard to diagnose

**User Impact**:
This only affects developers, not end users. A missing env var would cause the entire app to fail to connect to Convex. The error would be visible but not immediately actionable.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Add a runtime check: `if (!url) throw new Error(...)` | Clear DX error message | Extra code for dev-only concern |
| B | Leave as-is; Convex SDK gives its own error | No extra code | Error message less clear |

**Recommended**: Option B

**Reasoning**:
This is a standard Vite + Convex pattern. The Convex SDK will throw its own error if the URL is invalid. Adding a validation guard is unnecessary defense for a development-time configuration issue.

---

## Error Handler Audit

| Location | Type | Logging | User Feedback | Specificity | Verdict |
|----------|------|---------|---------------|-------------|---------|
| `src/lib/errorHandler.ts:19` | function | N/A (returns message) | GOOD (maps codes to messages) | GOOD (checks instanceof + shape) | PASS |
| `src/components/auth/ProtectedRoute.tsx:4` | auth guard | N/A | GOOD (redirects to /login) | GOOD | PASS |
| `src/components/auth/AdminRoute.tsx:5` | auth+role guard | N/A | BAD (null user bypasses guard) | BAD (doesn't handle null user) | FAIL |
| `convex/users.ts:6` | null check | N/A | GOOD (returns null) | BAD (email! assertion) | FAIL |
| `src/lib/convex.ts:3` | env var cast | N/A | N/A | LOW (no validation) | PASS |

---

## Statistics

| Severity | Count | Auto-fixable |
|----------|-------|--------------|
| CRITICAL | 0 | 0 |
| HIGH | 2 | 2 |
| MEDIUM | 1 | 0 |
| LOW | 1 | 1 |

---

## Silent Failure Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Admin route bypass via null user | MEDIUM | HIGH | Fix AdminRoute to deny-by-default (Finding 3) |
| identity.email undefined in users.me | LOW | MEDIUM | Guard for missing email (Finding 1) |
| Unhandled Convex errors in UI | MEDIUM | MEDIUM | Wire handleConvexError when toast is built (Finding 2) |
| Missing VITE_CONVEX_URL | LOW | LOW | Convex SDK provides its own error (Finding 4) |

---

## Patterns Referenced

| File | Lines | Pattern |
|------|-------|---------|
| `src/lib/errorHandler.ts` | 19-30 | `instanceof ConvexError` + shape check + code lookup with generic fallback |
| `convex/lib/errors.ts` | 32-37 | `appError()` factory creating typed `ConvexError<AppErrorData>` |
| `src/components/auth/ProtectedRoute.tsx` | 4-20 | Loading spinner -> auth check -> redirect or render pattern |

---

## Positive Observations

- **`handleConvexError` is well-designed**: Handles `unknown` input type, checks `instanceof ConvexError`, validates data shape before accessing `code`, and provides a generic fallback. This is defensive and correct.
- **Comprehensive test coverage**: The `errorHandler.test.ts` covers all 9 error codes, edge cases (null, undefined, string, malformed ConvexError), and verifies messages don't leak raw codes. Excellent.
- **`ProtectedRoute` is clean and correct**: Simple loading/auth/render flow with no error handling needed — `useConvexAuth()` handles its own loading state.
- **Backend error utilities are well-typed**: `convex/lib/errors.ts` provides typed factory functions for each error code, ensuring consistency between backend error creation and frontend error handling.
- **`AppErrorData` type is shared**: Both backend (`convex/lib/errors.ts`) and frontend (`src/lib/errorHandler.ts`) reference the same type, preventing drift.

---

## Metadata

- **Agent**: error-handling-agent
- **Timestamp**: 2026-05-14T00:00:00Z
- **Artifact**: `/home/user/.archon/workspaces/joshuarossi/Clarity/artifacts/runs/0ef7b1a87a8f908fb5f48ae5fa8ddc49/review/error-handling-findings.md`
