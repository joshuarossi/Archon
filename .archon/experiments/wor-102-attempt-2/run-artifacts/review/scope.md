# Review Scope

**Ticket**: 'WOR-102'
**PR**: #14
**Branch**: archon/task-wor-102
**Compared against main SHA**: be7ae9d

## Changed Files

- .changelog/wor-102.md
- README.md
- convex/_generated/api.d.ts
- convex/users.ts
- docs/app-shell.md
- docs/contracts/wor-102.md
- docs/errors.md
- e2e/app-shell.spec.ts
- package-lock.json
- package.json
- src/App.tsx
- src/components/layout/AdminRoute.tsx
- src/components/layout/ProtectedRoute.tsx
- src/components/layout/TopNav.tsx
- src/lib/errorHandler.ts
- src/main.tsx
- src/vite-env.d.ts
- tests/unit/errorHandler.test.ts
- tests/unit/theme-tokens.test.ts
- tests/unit/vite-config.test.ts

## Task Context

# Task WOR-102: App shell — Vite + React + ConvexProvider + AuthProvider + routing

## Metadata

- **Key:** WOR-102
- **Status:** In Progress
- **Type:** Task
- **Parent Epic:** WOR-90
- **Labels:** (none)

## Full Description

This task establishes the frontend application skeleton that every subsequent UI task builds on. It wires up the Vite dev server, React 18 entry point, Convex reactive backend connection (ConvexProvider), authentication layer (Convex Auth provider), and the full React Router v6 route tree defined in TechSpec §9.2. Without this shell, no frontend page can render, authenticate, or subscribe to live data. The task also includes the TopNav component (logged-in and case-detail variants per DesignDoc §3.2) and a frontend error handler utility that maps Convex error codes to user-friendly toast messages.

Acceptance Criteria

main.tsx renders React 18 with ConvexProvider and AuthProvider wrapping the router



App.tsx defines all routes from TechSpec §9.2: /, /login, /invite/:token, /dashboard, /cases/new, /cases/:caseId, /cases/:caseId/private, /cases/:caseId/joint, /cases/:caseId/closed, /admin/templates, /admin/templates/:id, /admin/audit



Protected routes redirect to /login when unauthenticated



Admin routes (/admin/*) redirect to /dashboard for non-admin users



TopNav renders the logged-in variant with Dashboard link and user menu, and the case-detail variant with back arrow and phase display per DesignDoc §3.2



Navigation between routes works with browser back/forward buttons



Vite config includes VITE_CONVEX_URL environment variable



Frontend error handler utility maps ConvexError codes (UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT, etc.) to user-friendly toast messages





Implementation Notes

**Tech stack:** React 18, Vite, TypeScript, React Router v6, Convex (convex/react hooks), @convex-dev/auth for auth provider.



**File structure (TechSpec §9.1):** src/main.tsx (entry point with providers), src/App.tsx (route definitions), src/components/layout/TopNav.tsx, src/lib/ for error handler utility.



**Provider nesting order:** <ConvexProvider> → <ConvexAuthProvider> → <BrowserRouter> → <Routes>. The Convex URL comes from import.meta.env.VITE_CONVEX_URL.



**Protected route pattern:** A wrapper component checks useConvexAuth() — if isLoading, show spinner; if !isAuthenticated, <Navigate to="/login" replace />.



**Admin route guard:** After auth check, query the current user's role. If role !== "ADMIN", redirect to /dashboard.



**TopNav variants:** Logged-out (minimal), logged-in (Dashboard link + user menu), case-detail (back arrow via ArrowLeft icon at 14px + phase display). Conditional rendering based on route and auth state.



**Error handler utility (TechSpec §7.4):** Maps the 9 Convex error codes (UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT, INVALID_INPUT, TOKEN_INVALID, RATE_LIMITED, AI_ERROR, INTERNAL) to user-friendly messages for toast display. Wrap in a handleConvexError(error) function.



**Route pages:** Use placeholder/stub components for pages not yet implemented — just enough to render a heading and confirm routing works. Actual page content is built in later tasks.



**Accessibility (NFR-A11Y):** On route change, focus should move to the page's <h1>. Correct landmarks (<main>, <nav>). Focus rings via :focus-visible.



**Browser support (NFR-BROWSER):** Vite build target es2020. No IE or legacy browser support needed.



**Dependencies:** Depends on P0.1 (project scaffolding/Vite init), T1 (Convex schema — needed for auth/user types), and T9 (theme/style setup — needed for TopNav styling).





Test-Gen Brief

**AC: main.tsx renders providers** — Integration test (Playwright): load the app root URL, verify the page renders without console errors. Assert that the Convex connection initializes (no "failed to connect" errors).



**AC: Route definitions** — E2E test (Playwright): navigate to each route path and verify the correct page component renders (check for page heading or unique test-id). Cover: /, /login, /dashboard, /cases/new, /admin/templates, /admin/audit.



**AC: Protected routes redirect** — E2E test (Playwright): in an unauthenticated browser context, navigate to /dashboard and assert redirect to /login. Same for /cases/new, /admin/templates.



**AC: Admin routes redirect non-admins** — E2E test (Playwright): log in as a regular USER, navigate to /admin/templates, assert redirect to /dashboard.



**AC: TopNav variants** — E2E test (Playwright): verify logged-in TopNav shows Dashboard link and user menu. On a case detail page, verify back arrow and phase display are present.



**AC: Browser back/forward** — E2E test (Playwright): navigate /dashboard → /cases/new → browser back → assert on /dashboard → browser forward → assert on /cases/new.



**AC: VITE_CONVEX_URL** — Unit test (Vitest): verify vite.config.ts is valid and doesn't error. The env var itself is a runtime config, tested implicitly by E2E.



**AC: Error handler utility** — Unit test (Vitest): import the error handler, pass each of the 9 ConvexError codes, assert the returned message is a non-empty user-friendly string (not the raw code). Test unknown code falls back to a generic message. Fixtures: mock ConvexError objects with each code.





Traceability

Decomposed from Epic WOR-90 plan task_id T8. Depends on plan task_ids: P0.1, T1, T9.
