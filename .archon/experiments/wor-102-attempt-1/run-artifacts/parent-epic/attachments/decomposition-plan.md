# Epic Decomposition Plan: undefined — Clarity — v1

## Planning Assumptions

- P2 user stories (US-16 through US-19: email notifications, voluntary transcript sharing, PDF export, inline rephrase) are deferred to v1.1 and excluded from this plan.
- Convex Auth is the auth provider for v1 per TechSpec §4.1; Clerk swap is a contingency, not planned.
- Privacy response filter uses token-substring matching (≥8 contiguous tokens) per TechSpec TQ2; embedding similarity deferred.
- Synthesis is one-shot non-streaming per TechSpec TQ3.
- Typing indicators ('Jordan is typing...') are deferred to v1.1 per TechSpec §8.3; visual space is reserved.
- 24h cooling-off for unilateral close is deferred to v1.1 per TechSpec §5.2; v1 unilateral close is immediate.
- Dark mode is included in v1 per DesignDoc D4, implemented via CSS custom properties with data-theme toggle.
- No message deletion or editing in v1 per TechSpec TQ6.
- Cost budgeting per TechSpec §6.6 deferred: COST_LIMITED status is absent from the normative schema §3.1 (which defines exactly 7 statuses, none named COST_LIMITED), indicating a spec-internal inconsistency between §6.6 and §3.1. Token counts are recorded per AI action (enabling future cost tracking), but cap enforcement, graceful degradation to templated boilerplate, and the COST_LIMITED status are deferred to post-beta. The §6.6 soft cap ($2) and hard cap ($10) thresholds are not implemented in v1.

## Proposed Task Graph

Root tasks (no blockers): P0.1, P0.2, P0.3, P0.4, T6, T9.

Dependencies:
- T1 blocked by P0.1
- T2 blocked by T1
- T3 blocked by T1
- T4 blocked by T1
- T5 blocked by T1
- T7 blocked by P0.2
- T8 blocked by P0.1, T1, T9
- T10 blocked by T9, T11
- T11 blocked by T9
- T12 blocked by T1
- T13 blocked by P0.1
- T14 blocked by P0.4, T13
- T15 blocked by T1, T3, T4, P0.3
- T16 blocked by T8, T15
- T17 blocked by T1, T2, T3, T4
- T18 blocked by T1, T3, T4, T2
- T19 blocked by T8, T17, T11
- T20 blocked by T8, T17, T18
- T21 blocked by T8, T18, T15, T11
- T22 blocked by T8, T17, T11
- T23 blocked by T1, T2, T3, T4
- T24 blocked by T23, T5, T7, P0.2
- T25 blocked by T23, T24, T10, T11, T8
- T26 blocked by T17, T8, T11
- T27 blocked by T17, T8, T2
- T28 blocked by T5, T6, T7, P0.2, T23, T2
- T29 blocked by T28, T8, T11
- T30 blocked by T1, T2, T3, T4
- T31 blocked by T30, T5, T6, T7, P0.2
- T32 blocked by T30, T31, T10, T8
- T33 blocked by T1, T3, T4, T30
- T34 blocked by T33, T5, T7, P0.2
- T35 blocked by T33, T34, T10
- T36 blocked by T30, T8
- T37 blocked by T30, T8, T10
- T38 blocked by T1, T3, T4
- T39 blocked by T38, T8
- T40 blocked by T38, T8
- T41 blocked by T38, T8
- T42 blocked by T1, T2
- T43 blocked by T8, T9

## Task Breakdown

### P0.1: Provision Convex Cloud Project

**Type:** Task

**Summary:** Create a Convex cloud project for development. This provides the managed database, serverless functions, real-time subscriptions, and auth infrastructure that the entire backend depends on.

**Acceptance Criteria:**

- Convex cloud project created at dashboard.convex.dev with a development deployment
- VITE_CONVEX_URL environment variable captured from the Convex dashboard
- Running 'npx convex dev' in a fresh clone connects successfully to the deployment
- Verified by deploying a trivial schema and confirming it appears in the Convex dashboard

### P0.2: Obtain Anthropic API Key

**Type:** Task

**Summary:** Create an Anthropic API key for Claude Sonnet 4.5 and Haiku 4.5 access. All AI features (private coaching, synthesis, joint chat coach, draft coach, transcript compression, inflammatory classification) depend on this key.

**Acceptance Criteria:**

- Anthropic API key created at console.anthropic.com with access to claude-sonnet-4-5 and claude-haiku-4-5-20251001 models
- API key stored as ANTHROPIC_API_KEY environment variable in the Convex deployment
- Verified by running a test API call to Claude Sonnet from a Convex action that returns a successful response
- Budget alerts configured on the Anthropic dashboard for the development environment

### P0.3: Configure Google OAuth Credentials

**Type:** Task

**Summary:** Set up a Google OAuth 2.0 client for the 'Continue with Google' login flow. Convex Auth requires GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.

**Acceptance Criteria:**

- Google OAuth 2.0 client created in Google Cloud Console with authorized redirect URIs for localhost and the Convex auth callback
- GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET stored as environment variables in the Convex deployment
- Verified by completing a Google OAuth login flow in the dev environment that creates a user session

### P0.4: Set Up GitHub Repository with Actions

**Type:** Task

**Summary:** Create the GitHub repository and configure Actions for CI. The CI pipeline (lint, typecheck, unit tests, E2E tests) runs on every push and PR.

**Acceptance Criteria:**

- GitHub repository created with main branch protection (require PR reviews, require CI pass)
- GitHub Actions workflow file runs successfully on a push (even if only a placeholder step)
- Repository secrets configured: CONVEX_DEPLOY_KEY (for CI Convex deployment), ANTHROPIC_API_KEY (for E2E tests with mock mode)
- Verified by pushing a trivial commit and seeing a green Actions run

### T1: Convex schema definition (convex/schema.ts)

**Type:** Task

**Summary:** Define the complete Convex schema matching TechSpec §3.1 exactly: users, cases, partyStates, privateMessages, jointMessages, draftSessions, draftMessages, inviteTokens, templates, templateVersions, auditLog. All tables, fields, validators, and indexes as specified. This is the source of truth for end-to-end type safety.

**Depends on:** P0.1

**Acceptance Criteria:**

- convex/schema.ts defines all 11 tables with all fields, types, and validators exactly as specified in TechSpec §3.1
- All indexes defined: users.by_email, cases.by_initiator, cases.by_invitee, partyStates.by_case, partyStates.by_case_and_user, privateMessages.by_case_and_user, privateMessages.by_case, jointMessages.by_case, draftSessions.by_case_and_user, draftMessages.by_draft_session, inviteTokens.by_token, inviteTokens.by_case, templates.by_category, templateVersions.by_template, auditLog.by_actor
- cases.status union includes all 7 states: DRAFT_PRIVATE_COACHING, BOTH_PRIVATE_COACHING, READY_FOR_JOINT, JOINT_ACTIVE, CLOSED_RESOLVED, CLOSED_UNRESOLVED, CLOSED_ABANDONED
- cases.schemaVersion is v.literal(1)
- Schema deploys successfully to the Convex development deployment via 'npx convex dev'
- TypeScript types are generated and importable in both convex/ and src/ code

### T2: Case lifecycle state machine helper (convex/lib/stateMachine.ts)

**Type:** Task

**Summary:** Implement the state machine from TechSpec §5 as a single helper module. Every mutation that transitions case status calls this module. It validates preconditions, enforces legal transitions, and prevents illegal state jumps. The state machine is the enforcement backbone for the entire case lifecycle.

**Depends on:** T1

**Acceptance Criteria:**

- Module exports a validateTransition function that takes current status + requested transition and returns the new status or throws CONFLICT
- All 7 transitions are implemented: the 6 from TechSpec §5.1 (DRAFT_PRIVATE_COACHING → BOTH_PRIVATE_COACHING, BOTH_PRIVATE_COACHING → READY_FOR_JOINT, READY_FOR_JOINT → JOINT_ACTIVE, JOINT_ACTIVE → CLOSED_RESOLVED, JOINT_ACTIVE → CLOSED_UNRESOLVED, JOINT_ACTIVE → CLOSED_ABANDONED) plus DRAFT_PRIVATE_COACHING → CLOSED_ABANDONED (invite decline per DesignDoc §4.3)
- Illegal transitions throw ConvexError with code CONFLICT and a descriptive message naming both the current state and the attempted transition
- Vitest unit tests cover every legal transition and at least 5 illegal transitions (e.g., DRAFT_PRIVATE_COACHING → JOINT_ACTIVE, CLOSED_RESOLVED → anything)
- Closure transition (JOINT_ACTIVE → CLOSED_RESOLVED) requires both partyStates to have closureProposed=true and closureConfirmed=true

### T3: Auth identity helper and authorization utilities (convex/lib/auth.ts)

**Type:** Task

**Summary:** Implement the shared auth helper that every Convex function uses to authenticate and authorize the caller. Includes getUserIdentity, getUserByEmail, requireAuth (throws UNAUTHENTICATED), requirePartyToCase (throws FORBIDDEN), and requireAdmin (throws FORBIDDEN). This module is the first line of defense for privacy and access control.

**Depends on:** T1

**Acceptance Criteria:**

- requireAuth(ctx) returns the authenticated user record or throws UNAUTHENTICATED error
- getUserByEmail(ctx, email) upserts a users row on first login (role defaults to USER) and returns the user record
- requirePartyToCase(ctx, caseId, userId) verifies the user is either initiatorUserId or inviteeUserId on the case, or throws FORBIDDEN
- requireAdmin(ctx) verifies user.role === 'ADMIN' server-side, or throws FORBIDDEN
- Vitest unit tests verify each helper throws the correct error code on unauthorized access
- No query or mutation can bypass auth by importing the table directly — all access goes through these helpers

### T4: ConvexError wrapper and error codes (convex/lib/errors.ts)

**Type:** Task

**Summary:** Implement the normalized error shape from TechSpec §7.4. All thrown errors use ConvexError with {code, message, httpStatus}. This provides consistent error handling across all functions and a predictable error contract for the frontend.

**Depends on:** T1

**Acceptance Criteria:**

- Module exports typed error constructors for all 9 codes: UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT, INVALID_INPUT, TOKEN_INVALID, RATE_LIMITED, AI_ERROR, INTERNAL
- Each error constructor takes a message string and returns a ConvexError with the correct code and httpStatus
- Vitest unit tests verify each constructor produces the expected shape

### T5: Prompt assembly module (convex/lib/prompts.ts)

**Type:** Task

**Summary:** Implement the shared prompt assembly function from TechSpec §6.3. All four AI roles (PRIVATE_COACH, COACH, DRAFT_COACH, SYNTHESIS) use this module to build their system prompts and message arrays. It enforces context isolation: the private coach context never includes the other party's data; the coach and synthesis include both parties' content with anti-quotation instructions.

**Depends on:** T1

**Acceptance Criteria:**

- assemblePrompt function accepts {role, caseId, actingUserId, recentHistory, templateVersion?} and returns {system: string, messages: Message[]}
- PRIVATE_COACH role: system prompt matches TechSpec §6.3.1 verbatim, context includes only the acting party's form fields and private message history, no other party data is included
- SYNTHESIS role: system prompt includes the verbatim anti-quotation instruction from TechSpec §6.3.2, output format is strict JSON {forInitiator, forInvitee}
- COACH role: context includes joint chat history + both parties' synthesis texts (NOT raw private messages), anti-quotation rule included
- DRAFT_COACH role: context includes drafting user's joint-chat history + their own synthesis, NOT the other party's synthesis or private content
- Template version instructions are injected when a category-specific template is available
- Vitest unit tests verify context isolation for each role — PRIVATE_COACH context must not contain other party's messages

### T6: Privacy response filter (convex/lib/privacyFilter.ts)

**Type:** Task

**Summary:** Implement the server-side response filter from TechSpec §6.3.2 that prevents AI outputs from leaking the other party's raw private content. Before emitting any Coach or Synthesis output, tokenize the other party's private messages and check for any substring of ≥8 consecutive tokens matching. If found, the response is flagged for regeneration.

**Acceptance Criteria:**

- filterResponse(candidateText, otherPartyMessages) returns {passed: boolean, matchedSubstring?: string}
- Tokenization splits on whitespace and punctuation boundaries
- A match is defined as ≥8 consecutive tokens from any single private message appearing in the candidate text
- Vitest unit tests include: exact 8-token match (fails), 7-token match (passes), paraphrased content (passes), empty other-party messages (passes), multiple messages checked
- Adversarial test cases: quoted text with minor word substitutions (should pass), verbatim copy-paste (should fail)
- Module is pure (no DB access) — callers pass in the message content

### T7: Transcript compression module (convex/lib/compression.ts)

**Type:** Task

**Summary:** Implement transcript compression from TechSpec §6.4. When total token count exceeds the budget (60k for generation, 10k for classification), compress the oldest 50% of messages into a Haiku-generated summary. Cache summaries by content hash for reuse.

**Depends on:** P0.2

**Acceptance Criteria:**

- compressTranscript(messages, budgetTokens) returns a compressed message array that fits within the budget
- Oldest 50% of messages are replaced with a single SUMMARY message generated by Claude Haiku
- Haiku compression prompt matches TechSpec §6.4: 'Summarize this conversation segment in 500 tokens or fewer, preserving facts, decisions, emotional tone, and unresolved threads'
- Summaries are cached by content hash; repeated compression of the same segment returns cached result
- Vitest unit tests verify: messages under budget are returned unchanged, messages over budget are compressed, cache hit returns same result without API call

### T8: App shell — Vite + React + ConvexProvider + AuthProvider + routing

**Type:** Task

**Summary:** Set up the frontend application shell: Vite config, React 18 entry point, ConvexProvider wrapping the app, Convex Auth provider, React Router v6 with all routes from TechSpec §9.2. Includes TopNav component with conditional rendering for logged-in/logged-out states and in-case navigation with back-to-dashboard link and phase display. Also includes the frontend error handler utility that maps ConvexError codes to user-friendly messages.

**Depends on:** P0.1, T1, T9

**Acceptance Criteria:**

- main.tsx renders React 18 with ConvexProvider and AuthProvider wrapping the router
- App.tsx defines all routes from TechSpec §9.2: /, /login, /invite/:token, /dashboard, /cases/new, /cases/:caseId, /cases/:caseId/private, /cases/:caseId/joint, /cases/:caseId/closed, /admin/templates, /admin/templates/:id, /admin/audit
- Protected routes redirect to /login when unauthenticated
- Admin routes (/admin/*) redirect to /dashboard for non-admin users
- TopNav renders the logged-in variant with Dashboard link and user menu, and the case-detail variant with back arrow and phase display per DesignDoc §3.2
- Navigation between routes works with browser back/forward buttons
- Vite config includes VITE_CONVEX_URL environment variable
- Frontend error handler utility maps ConvexError codes (UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT, etc.) to user-friendly toast messages

### T9: Theme and style setup — globals.css, components.css, tailwind config, shadcn overrides

**Type:** Task

**Summary:** Set up the complete visual foundation per the Style Guide. Copy globals.css with all CSS custom property tokens (light + dark themes), components.css with reusable class recipes (.cc-btn-primary, .cc-bubble-coach, etc.), theme.ts TypeScript mirror, and tailwind config. Configure shadcn/ui primitives with Clarity overrides. Wire data-theme toggle with localStorage + prefers-color-scheme detection.

**Acceptance Criteria:**

- globals.css declares all color tokens from StyleGuide §2.2 for both light and dark themes via [data-theme] selectors
- All spacing, radius, shadow, and motion tokens from StyleGuide §4 are declared as CSS custom properties
- Inter (400/500/600) and JetBrains Mono (400/500) loaded from Google Fonts
- Typography scale from StyleGuide §3.3 implemented as utility classes or CSS variables
- components.css includes all chat bubble variants from StyleGuide §6.4: .cc-bubble, .cc-bubble-coach, .cc-bubble-coach-joint, .cc-bubble-coach-intervention, .cc-bubble-party-initiator, .cc-bubble-party-invitee, .cc-bubble-error
- Dark mode toggle works: reads prefers-color-scheme on initial load, stores preference in localStorage, applies data-theme attribute before first paint (no flash)
- shadcn/ui Button component overridden with Clarity variants: primary (sage fill), secondary, ghost, danger, link per StyleGuide §6.1
- Font smoothing rules from StyleGuide §3.4 applied to html element
- prefers-reduced-motion media query disables streaming cursor animation and route crossfades per StyleGuide §5

### T10: Shared chat components — ChatWindow, MessageBubble, MessageInput, StreamingIndicator

**Type:** Task

**Summary:** Build the core chat component system used by Private Coaching, Joint Chat, and Draft Coach. ChatWindow is the base layout; MessageBubble handles all 7 visual variants; MessageInput provides textarea with Enter-to-send and Shift-Enter for newline; StreamingIndicator shows the blinking cursor during AI generation.

**Depends on:** T9, T11

**Acceptance Criteria:**

- ChatWindow component accepts a messages array and renders them in a scrollable container with role='log' and aria-live='polite'
- Auto-scroll follows latest message UNLESS user has scrolled up (sticky scroll detection via scroll position)
- MessageBubble renders 7 variants per StyleGuide §6.4: user, coach (private), coach (joint), coach intervention, party-initiator, party-invitee, error
- MessageBubble renders differently by status: STREAMING shows content + blinking cursor, COMPLETE shows full content + copy button + timestamp, ERROR shows error styling + Retry button
- MessageInput implements Enter-to-send, Shift-Enter for newline, Send button disabled while AI is responding, textarea enabled for pre-typing
- StreamingIndicator is a 2px × 1em currentColor bar with 1s steps(2) blink animation, removed when streaming completes
- Timestamps appear on hover per DesignDoc §4.9
- New message arrival animates with 150ms fade-in + 8px upward translate per StyleGuide §6.4
- Copy button only appears on COMPLETE messages

### T11: Shared UI primitives — PrivacyBanner, StatusPill, PartyAvatar, PhaseHeader

**Type:** Task

**Summary:** Build the shared UI components used across multiple pages. PrivacyBanner is the consistent 'this is private to you' callout with lock icon and private-tint background. StatusPill shows case status with color + shape encoding. PartyAvatar renders colored circles with initials. PhaseHeader is the top strip for in-case screens.

**Depends on:** T9

**Acceptance Criteria:**

- PrivacyBanner renders with --private-tint background, Lock icon (lucide), and customizable copy (e.g., 'Private to you. Jordan will never see any of it.') per StyleGuide §6.6
- PrivacyBanner lock icon click opens a modal explaining what's private and why per DesignDoc §4.7
- StatusPill renders 4 variants per StyleGuide §6.7: pill-turn (green filled circle), pill-waiting (gray hollow circle), pill-ready (amber), pill-closed (neutral square)
- PartyAvatar renders 32×32 circles with white initials on party color: initiator=--party-initiator, invitee=--party-invitee, coach=--coach-accent per StyleGuide §6.5
- PhaseHeader renders: back arrow + Dashboard link (left), case name + phase name (center), phase-specific actions (right) per StyleGuide §6.13, height 56px
- All components meet WCAG AA contrast requirements
- All icon buttons have aria-label attributes

### T12: Seed data script (convex/seed.ts)

**Type:** Task

**Summary:** Implement the seed data script from TechSpec §11.4. Creates one admin user and 3 default templates (workplace, family, personal) with minimal globalGuidance. Admin-callable in dev only.

**Depends on:** T1

**Acceptance Criteria:**

- convex/seed.ts creates one admin user with role='ADMIN' and a known email for dev/testing
- Creates 3 default templates: workplace, family, personal — each with a minimal globalGuidance and an initial templateVersion
- Seed is idempotent: running it twice does not create duplicates (checks by email / category before inserting)
- Seed function is gated to development environment only (throws in production)

### T13: Playwright infrastructure — config, fixtures, Claude mock mode, CI wiring

**Type:** Task

**Summary:** Set up Playwright testing infrastructure per TechSpec §10. Includes playwright.config.ts, shared test fixtures (authenticated user contexts, Convex dev deployment), and the CLAUDE_MOCK=true test mode that makes AI actions return deterministic stub responses with configurable delays.

**Depends on:** P0.1

**Acceptance Criteria:**

- playwright.config.ts configured for Chromium, Firefox, WebKit with baseURL pointing to localhost dev server
- Shared fixture: authenticated user context that logs in via test helper (bypassing real magic link for speed)
- Shared fixture: two-user context for invite-flow tests (two separate browser contexts)
- CLAUDE_MOCK=true environment variable makes all AI actions use a deterministic stub responder: canned responses for each role (private coach, coach, draft coach, synthesis) with configurable streaming delay
- Stub responses are realistic enough to exercise UI (valid markdown, proper JSON for synthesis)
- A placeholder test file (e.g., smoke.spec.ts) runs end-to-end and passes: opens the app, verifies the landing page loads
- Test utility functions for common operations: createTestUser, createTestCase, loginAs

### T14: CI pipeline — GitHub Actions (lint, typecheck, unit, e2e)

**Type:** Task

**Summary:** Implement the GitHub Actions CI workflow from TechSpec §10.3. Four sequential jobs: lint (ESLint + Prettier), typecheck (tsc --noEmit), unit (Vitest), e2e (Playwright with Convex dev deployment and CLAUDE_MOCK=true).

**Depends on:** P0.4, T13

**Acceptance Criteria:**

- GitHub Actions workflow file (.github/workflows/ci.yml) triggers on push and pull_request to main
- Lint job runs ESLint and Prettier check; fails on any violation
- Typecheck job runs tsc --noEmit; fails on any type error
- Unit job runs vitest; fails on any test failure
- E2E job spins up a Convex dev deployment, seeds test data, runs Playwright with CLAUDE_MOCK=true; fails on any test failure
- All jobs use Node.js LTS and cache node_modules
- Workflow completes in under 10 minutes for a clean run

### T15: Auth Convex module — Convex Auth setup, magic link + Google OAuth, user upsert

**Type:** Task

**Summary:** Configure Convex Auth with magic link and Google OAuth providers per TechSpec §4. On first login, upsert a user row in the users table keyed by email with role defaulting to USER. Session persists across browser reloads until explicit logout or 30-day expiry.

**Depends on:** T1, T3, T4, P0.3

**Acceptance Criteria:**

- Convex Auth configured with magic link provider (email-based one-time login link)
- Convex Auth configured with Google OAuth provider using GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET environment variables
- On first login (any provider), a users row is created with email, role='USER', createdAt=now
- On subsequent login, existing users row is returned without modification
- Session persists across browser reloads
- Logout mutation clears session client + server side per US-02
- No password-based registration (magic link only)
- ctx.auth.getUserIdentity() returns the authenticated identity in all subsequent function calls

### T16: Login/Register page and profile page

**Type:** Story

**Summary:** Build the login/register page per DesignDoc §4.2 and a minimal profile page. Login page has a centered card with email input + 'Send magic link' button, 'or' divider, 'Continue with Google' button, and terms/privacy fine print. Profile page shows display name, email, and sign-out button.

**Depends on:** T8, T15

**Acceptance Criteria:**

- Login page renders centered card (~400px wide) with 'Sign in to Clarity' heading
- Email input + 'Send magic link' primary button submits and shows 'Check your email...' confirmation state
- 'Continue with Google' secondary button initiates Google OAuth flow
- Fine print: 'By signing in, you agree to our Terms and Privacy Policy'
- Error state: inline error message below email input
- Post-login redirect to /dashboard (or original destination if redirect was triggered by protected route)
- Profile page (/profile) shows display name (editable), email (read-only), sign-out button
- Logout redirects to landing/login page per US-02
- All form elements have proper labels, keyboard navigation works, WCAG AA contrast met

### T17: Cases Convex module — create, get, list, partyStates queries + mutations

**Type:** Task

**Summary:** Implement the cases domain Convex functions from TechSpec §7.1-7.2: cases/list (reactive query returning current user's cases), cases/get, cases/partyStates (returns self state + other party phase-level-only status), cases/create mutation (creates case + initiator partyStates + invite token), cases/updateMyForm mutation.

**Depends on:** T1, T2, T3, T4

**Acceptance Criteria:**

- cases/list query returns all cases where the caller is initiatorUserId or inviteeUserId, sorted by updatedAt descending
- cases/get query returns case details only if caller is a party to the case; throws FORBIDDEN otherwise
- cases/partyStates query returns the caller's full partyState + the other party's phase-level status only (hasCompletedPC boolean, no form content, no private messages)
- cases/create mutation creates case with status=DRAFT_PRIVATE_COACHING, sets initiatorUserId, creates partyStates row for initiator, generates invite token, returns caseId + invite URL
- cases/create with isSolo=true creates case with both initiator and invitee bound to the same user, status=BOTH_PRIVATE_COACHING
- cases/create pins templateVersionId at creation time using the category's current active template version
- cases/updateMyForm mutation updates the caller's partyStates form fields (mainTopic, description, desiredOutcome)
- All functions enforce auth via requireAuth helper
- All functions use state machine helper for status transitions

### T18: Invite Convex module — token generation + redeem mutation

**Type:** Task

**Summary:** Implement the invite flow from TechSpec §4.4: crypto-random token generation (32 url-safe chars), invites/redeem mutation that binds the invited party to the case, creates their partyStates row, and marks the token consumed — all atomically in one transaction.

**Depends on:** T1, T3, T4, T2

**Acceptance Criteria:**

- Token generation produces 32 url-safe characters using crypto-random generation
- Invite URL format: {SITE_URL}/invite/{token}
- invites/redeem mutation validates token is ACTIVE, sets cases.inviteeUserId to the caller, creates partyStates row with role=INVITEE, marks token CONSUMED with consumedAt and consumedByUserId — all atomic
- Reusing a consumed token throws TOKEN_INVALID error with a clear message
- Token consumption transitions case from DRAFT_PRIVATE_COACHING to BOTH_PRIVATE_COACHING when invitee completes their form
- Redeeming an invite where the caller is already the initiator throws CONFLICT
- Vitest unit test verifies token uniqueness and url-safety

### T19: NewCasePage — case creation form with progressive disclosure

**Type:** Story

**Summary:** Build the case creation form per DesignDoc §4.5. Progressive disclosure: Step 1 category (radio cards), Step 2 main topic (one sentence, visible to other party), Step 3 describe situation (private, with privacy lock), Step 4 desired outcome (private), Step 5 other party's name. Solo mode toggle hidden under Advanced disclosure.

**Depends on:** T8, T17, T11

**Acceptance Criteria:**

- Category selection uses radio cards (not dropdown) for Workplace, Family, Personal relationship, Contractual/business, Other per DesignDoc §4.5
- Main topic field has label 'In one sentence, what's this about?' with helper text noting visibility to other person, soft 140 character limit with counter
- Description field has 'Private to you' label with lock icon and tooltip per DesignDoc §4.5, textarea auto-grows from 5 rows
- Desired outcome field has 'Private to you' label with lock icon, 3-row textarea
- Other party name field with helper 'Just a first name or nickname is fine'
- Solo mode checkbox under 'Advanced' expandable disclosure: 'Create this as a solo test case (I'll play both parties)'
- Submit calls cases/create mutation, routes to post-create invite sharing page on success
- Form validation: category required, main topic required, description required
- All form elements have proper labels, keyboard-navigable, WCAG AA compliant

### T20: Post-create invite sharing page

**Type:** Story

**Summary:** Build the post-create invite sharing page per DesignDoc §4.6. Shows the invite link in a large copyable field with Copy button, preset share options (email, text, just copy), suggested language for sharing, and a secondary CTA to start private coaching immediately.

**Depends on:** T8, T17, T18

**Acceptance Criteria:**

- Heading: 'Your case is ready. Send this link to [name].'
- Invite link displayed in a large, monospace field with 'Copy link' primary button
- Three share options: Copy for email (opens mailto with pre-written message), Copy for text (shorter variant), Just copy the link
- Expandable 'What should I tell them?' section with suggested language from DesignDoc §4.6
- Secondary CTA: 'Or, start your private coaching now →' linking to /cases/:caseId/private
- Copy button shows confirmation feedback ('Copied!') for 2 seconds
- Solo mode cases skip this page entirely and route directly to the case detail

### T21: InviteAcceptPage — invite acceptance flow

**Type:** Story

**Summary:** Build the invite acceptance page per DesignDoc §4.3. Logged-out view explains Clarity and prompts sign-in (token persists through auth). Logged-in view shows initiator's main topic and category with 'Accept invitation' and 'Decline' buttons. Privacy callout labels what the initiator wrote.

**Depends on:** T8, T18, T15, T11

**Acceptance Criteria:**

- Logged-out view: centered card with heading '[Name] has invited you to work through something together', body explaining Clarity, 'Sign in to continue' button
- Invite token persists through the auth flow (stored in URL or localStorage)
- Logged-in unredeemed view: shows initiator's main topic (one sentence) and category, 'Accept invitation' button, 'Decline' button
- Privacy callout: 'Alex wrote this in the shared summary. You'll have your own private space to share your perspective.' per DesignDoc §4.3
- Accept calls invites/redeem mutation, then routes to the invitee's form (same shape as initiator's case form: description + desired outcome) which is private to them
- Decline marks case CLOSED_ABANDONED and notifies initiator
- Consumed token shows error message with login/dashboard options
- All states keyboard-navigable and WCAG AA compliant

### T22: Dashboard page — case list with status indicators

**Type:** Story

**Summary:** Build the dashboard per DesignDoc §4.4. Lists cases grouped by Active and Closed (collapsed by default). Each row shows other party name, category, created date, status pill, last activity time, and Enter button. Empty state with friendly copy. '+ New Case' button top right. Supports US-05 (case lifecycle status visibility).

**Depends on:** T8, T17, T11

**Acceptance Criteria:**

- '+ New Case' primary button top right, routes to /cases/new
- Active Cases section shows cases not in CLOSED_* states, sorted by last activity
- Closed Cases section collapsed by default, shows CLOSED_* cases
- Each case row displays: PartyAvatar, other party name (or 'Waiting for invite' if invitee hasn't joined), category, created date, StatusPill with correct variant, last activity time, Enter button per DesignDoc §4.4
- Status indicator semantics per DesignDoc: green filled circle = your turn, gray hollow circle = waiting, amber = ready for joint, neutral square = closed
- Click on case row routes to /cases/:caseId (case detail)
- Solo mode cases are visually distinct (flagged with badge or label)
- Empty state: 'No cases yet. When you're ready to work through something, start a new case.'
- Skeleton loading state: 3 case row skeletons per DesignDoc §6.3
- Dashboard load: < 1s to first meaningful paint

### T23: Private coaching Convex module — queries + mutations

**Type:** Task

**Summary:** Implement the private coaching domain functions from TechSpec §7.1-7.2: privateCoaching/myMessages query (returns only the caller's messages, never the other party's), privateCoaching/sendUserMessage mutation (inserts message + schedules AI action), privateCoaching/markComplete mutation (sets privateCoachingCompletedAt, triggers synthesis if both complete).

**Depends on:** T1, T2, T3, T4

**Acceptance Criteria:**

- privateCoaching/myMessages query returns messages where userId matches the caller only — never returns messages belonging to another user for any caseId
- privateCoaching/myMessages query returns messages sorted by createdAt ascending
- privateCoaching/sendUserMessage mutation inserts a privateMessages row with role=USER, status=COMPLETE, and schedules generateAIResponse action
- privateCoaching/sendUserMessage validates case status is DRAFT_PRIVATE_COACHING or BOTH_PRIVATE_COACHING, throws CONFLICT otherwise
- privateCoaching/markComplete mutation sets the caller's privateCoachingCompletedAt; if both parties have completed, schedules synthesis/generate action
- markComplete is idempotent: calling it twice does not error or re-trigger synthesis
- All functions enforce auth via requireAuth and requirePartyToCase helpers
- Attempting to read another user's private messages returns empty array (not FORBIDDEN, to avoid information leakage about whether messages exist)

### T24: Private coaching AI action — generateAIResponse with streaming

**Type:** Task

**Summary:** Implement the privateCoaching/generateAIResponse action from TechSpec §7.3. Calls Claude Sonnet with streaming, using the prompt assembly module with PRIVATE_COACH role. Inserts a STREAMING message row and updates it as tokens arrive (~50ms batches). On completion, sets status to COMPLETE with total token count.

**Depends on:** T23, T5, T7, P0.2

**Acceptance Criteria:**

- Action reads the acting user's form fields + full prior private message history via prompt assembly module (PRIVATE_COACH role)
- Context NEVER includes the other party's private messages — enforced by prompt assembly module
- System prompt matches TechSpec §6.3.1 verbatim (calm, curious, non-judgmental listener)
- No template content is applied to the Private Coach per PRD US-06 AC
- Action inserts a privateMessages row with status=STREAMING and empty content
- Tokens stream into the row via batched mutation updates (~50ms intervals)
- On completion, final mutation sets status=COMPLETE and records total token count
- On AI failure: retry once with 2s backoff; on persistent failure, mark message as ERROR
- On rate limit (429): retry once with exponential backoff per TechSpec §6.5
- First token latency target < 2s

### T25: PrivateCoachingView page

**Type:** Story

**Summary:** Build the private coaching chat view per DesignDoc §4.7. Full-height chat layout with persistent privacy banner, ChatWindow showing coach and user messages, MessageInput with Enter-to-send, and a footer 'mark complete' CTA that opens a confirmation dialog.

**Depends on:** T23, T24, T10, T11, T8

**Acceptance Criteria:**

- Privacy banner at top: '🔒 This conversation is private to you. [Name] will never see any of it. Learn more about privacy' per DesignDoc §4.7
- Coach messages rendered in --accent-subtle bubbles, left-aligned, with Sparkles icon
- User messages rendered in --bg-surface bubbles, right-aligned
- Streaming behavior: AI message appears as bubble with blinking cursor, text streams, copy button appears only after COMPLETE
- Input: Shift-enter for newline, enter to send. While AI is responding, input enabled for pre-typing but Send is disabled
- 'Mark private coaching complete' is a footer CTA, not a prominent button — avoiding rush per DesignDoc §4.7
- Mark Complete opens confirmation dialog: 'You've had {N} messages with the Coach. Ready to move on to the joint session with [name]?' with Continue Coaching / Mark Complete buttons
- After marking complete, view shows read-only state with status message
- Subscribes to privateCoaching/myMessages reactive query; updates in real time
- AI error messages render inline with ERROR styling and Retry button per NFR-RELIABILITY

### T26: Solo mode — PartyToggle component + useSoloActingParty hook

**Type:** Story

**Summary:** Build the solo mode party toggle per DesignDoc §9.3 and StyleGuide §6.10. Toggle state stored in URL query param ?as=initiator|invitee. The useSoloActingParty hook reads the toggle and provides the correct userId to all data queries, effectively simulating two sessions in one browser.

**Depends on:** T17, T8, T11

**Acceptance Criteria:**

- PartyToggle renders a prominent segmented control with initiator name and invitee name, colored with --coach-accent border per StyleGuide §6.10
- 'VIEWING AS' uppercase label at 11px above the toggle per StyleGuide §6.10
- Toggle state stored in URL query param ?as=initiator|invitee (survives refresh)
- useSoloActingParty hook returns the userId corresponding to the active toggle selection
- All data queries (private messages, party state, synthesis) respect the acting party from the hook
- PartyToggle only renders on cases where isSolo=true
- Position: top-right of PhaseHeader in solo cases
- AI responses behave as if each party were separate (separate private coaching contexts per US-13 AC)
- Solo cases are visually distinct with coach-accent banner per DesignDoc

### T27: CaseDetail orchestrator page — routes by case status

**Type:** Task

**Summary:** Build the case detail orchestrator per TechSpec §9.1. This page reads the case status and renders the phase-appropriate subview: PrivateCoachingView, ReadyForJointView, JointChatView, or ClosedCaseView. It also handles the invitee form (same shape as case creation) for invitees who have just accepted.

**Depends on:** T17, T8, T2

**Acceptance Criteria:**

- Route /cases/:caseId reads case status and renders the correct subview
- DRAFT_PRIVATE_COACHING or BOTH_PRIVATE_COACHING → PrivateCoachingView (or invitee form if invitee hasn't completed form)
- READY_FOR_JOINT → ReadyForJointView
- JOINT_ACTIVE → JointChatView
- CLOSED_RESOLVED, CLOSED_UNRESOLVED, CLOSED_ABANDONED → ClosedCaseView
- Subroutes (/private, /joint, /closed) also work and redirect if case status doesn't match
- PhaseHeader shows correct phase name for current status
- If caller is not a party to the case, redirects to /dashboard with error toast
- Reactively updates: if case transitions status while user is viewing, the view updates in real time

### T28: Synthesis AI action — generate with privacy filter + state transition

**Type:** Task

**Summary:** Implement the synthesis/generate action from TechSpec §6.3.2. Triggered when both parties mark private coaching complete. Calls Claude Sonnet with both parties' private content to generate two independent synthesis texts. Output is strict JSON {forInitiator, forInvitee}, validated server-side. Response filter checks for cross-party content leakage. On success, writes to partyStates.synthesisText and transitions case to READY_FOR_JOINT.

**Depends on:** T5, T6, T7, P0.2, T23, T2

**Acceptance Criteria:**

- Action reads both parties' private coaching messages + form fields as context
- System prompt includes verbatim anti-quotation instruction from TechSpec §6.3.2
- Output format is strict JSON: {forInitiator: string, forInvitee: string}, validated before writing
- Response filter (T6) checks each synthesis text against the OTHER party's private messages (forInitiator checked against invitee's messages, forInvitee checked against initiator's messages)
- On filter match: regenerate up to 2 retries. On final failure: return generic fallback synthesis + flag for admin review via audit log
- On success: write synthesisText + synthesisGeneratedAt to each party's partyState, transition case to READY_FOR_JOINT — all in same mutation
- Synthesis is one-shot, non-streaming per TechSpec TQ3
- Loading state: 'Generating your guidance...' is surfaced to both parties during generation

### T29: ReadyForJointView page — synthesis display + Enter Joint Session CTA

**Type:** Story

**Summary:** Build the pre-joint-session page per DesignDoc §4.8. Shows the party's synthesis in a card with --private-tint background, three fixed sections (Areas of likely agreement, Points that will need real discussion, Suggested approach), and a primary 'Enter Joint Session →' button.

**Depends on:** T28, T8, T11

**Acceptance Criteria:**

- Reads synthesis from jointChat/mySynthesis reactive query
- Synthesis card rendered with --private-tint background, 32px padding, 14px radius per StyleGuide §6.8
- Privacy banner above synthesis: '🔒 Private to you — [Name] has their own version'
- Three H3 sections in order: Areas of likely agreement, Points that will need real discussion, Suggested approach — rendered as markdown
- Primary CTA: 'Enter Joint Session →' — large, sage fill, single primary action on page
- Clicking CTA transitions case to JOINT_ACTIVE and routes to /cases/:caseId/joint
- '[Name] will see you've entered when they enter too.' message below CTA
- Synthesis remains accessible from 'View my guidance' link in joint chat top nav after entering

### T30: Joint chat Convex module — queries + mutations including closure

**Type:** Task

**Summary:** Implement joint chat domain functions from TechSpec §7.1-7.2: jointChat/messages query (reactive, returns all joint messages for the case), jointChat/mySynthesis query, jointChat/sendUserMessage mutation (inserts message + schedules Coach evaluation), closure mutations (proposeClosure, confirmClosure, unilateralClose).

**Depends on:** T1, T2, T3, T4

**Acceptance Criteria:**

- jointChat/messages query returns all jointMessages for the case sorted by createdAt; enforces caller is a party to the case
- jointChat/mySynthesis query returns the caller's partyState.synthesisText
- jointChat/sendUserMessage mutation inserts a jointMessages row with authorType=USER, authorUserId=caller, status=COMPLETE, and schedules generateCoachResponse action
- sendUserMessage validates case is in JOINT_ACTIVE status, throws CONFLICT otherwise
- jointChat/proposeClosure mutation sets caller's closureProposed=true, stores proposed summary on case.closureSummary
- jointChat/confirmClosure mutation: if other party has proposed, transitions case to CLOSED_RESOLVED via state machine, sets closedAt
- jointChat/unilateralClose mutation transitions case to CLOSED_UNRESOLVED immediately (v1 simplification: no 24h cooling-off)
- Rejecting a closure proposal clears the proposer's closureProposed flag
- All functions enforce auth + party-to-case check

### T31: Joint chat Coach AI action — Haiku gate + Sonnet generation with streaming

**Type:** Task

**Summary:** Implement the jointChat/generateCoachResponse action from TechSpec §6.3.3. Two-step process: (1) Haiku classifies the last user message as INFLAMMATORY/PROGRESS/QUESTION_TO_COACH/NORMAL_EXCHANGE, (2) for non-NORMAL_EXCHANGE, Sonnet generates a Coach response streamed into jointMessages. Context includes joint chat history + both parties' synthesis (NOT raw private messages). Privacy response filter applied before emitting output.

**Depends on:** T30, T5, T6, T7, P0.2

**Acceptance Criteria:**

- Haiku classification step uses claude-haiku-4-5-20251001 to classify the last user message into one of: INFLAMMATORY, PROGRESS, QUESTION_TO_COACH, NORMAL_EXCHANGE
- Coach only generates a response for non-NORMAL_EXCHANGE classifications (unless a timer fires for 5+ exchanges with no Coach input)
- Sonnet generation uses category-specific template if available, else default baseline
- Context: joint chat history + BOTH parties' synthesis texts, NOT raw private messages
- Privacy response filter (T6) applied: Coach output checked against both parties' raw private messages before emitting
- On filter match: regenerate up to 2 retries; on final failure, post 'I'm having trouble responding to that right now. Could either of you rephrase?'
- Streaming: inserts jointMessages row with authorType=COACH, status=STREAMING, batched token updates, final COMPLETE status
- Coach intervention messages (INFLAMMATORY trigger) have isIntervention=true for distinct UI styling
- On @-mention by a party, always generates a response regardless of classification
- First token latency target < 3s for joint chat

### T32: JointChatView page — shared conversation with Coach

**Type:** Story

**Summary:** Build the joint chat view per DesignDoc §4.9. Full-height chat with party-colored message bubbles, Coach messages with lavender left border and ⟡ glyph, message input with optional 'Draft with Coach' button. Real-time updates via reactive query. Top nav includes 'My guidance' link and 'Close' action.

**Depends on:** T30, T31, T10, T8

**Acceptance Criteria:**

- Renders all joint messages via reactive query — both parties see updates in real time without refresh per US-09 AC
- Each participant has consistent avatar color: initiator = --party-initiator, invitee = --party-invitee, Coach = --coach-accent per DesignDoc §4.9
- Coach messages have 3px left border (--coach-accent), rendered in --coach-subtle background with ⟡ glyph
- Coach intervention messages (isIntervention=true) have 4px left border per StyleGuide §6.4
- Message input: textarea for direct typing + '✨ Draft with Coach' button that opens DraftCoachPanel
- Users can type directly and Send, bypassing Draft Coach entirely
- 'Coach is thinking...' inline message shown when Coach is generating
- Top nav: 'My guidance' link opens synthesis in a side panel or modal, 'Close' button opens closure modal
- Timestamps appear on hover
- Auto-scroll follows latest message unless user has scrolled up
- Message propagation target < 500ms (Convex reactive queries)
- AI error messages render inline with ERROR styling and Retry button per NFR-RELIABILITY

### T33: Draft coach Convex module — session queries + mutations

**Type:** Task

**Summary:** Implement the draft coach domain functions from TechSpec §7.1-7.2: draftCoach/session query (returns active session + messages for the caller), draftCoach/startSession mutation, draftCoach/sendMessage mutation, draftCoach/sendFinalDraft mutation (reads finalDraft, calls jointChat/sendUserMessage internally, marks session SENT), draftCoach/discardSession mutation.

**Depends on:** T1, T3, T4, T30

**Acceptance Criteria:**

- draftCoach/session query returns the caller's active draftSession + its draftMessages, or null if no active session
- draftCoach/startSession mutation creates a draftSessions row with status=ACTIVE and schedules Draft Coach AI action for an initial prompt
- draftCoach/sendMessage mutation inserts a draftMessages row with role=USER and schedules the Draft Coach AI action
- draftCoach/sendFinalDraft mutation reads session.finalDraft, calls jointChat/sendUserMessage internally to post the draft to joint chat, marks session status=SENT with completedAt
- sendFinalDraft requires finalDraft to be non-null (Coach must have produced a draft), throws CONFLICT otherwise
- draftCoach/discardSession mutation marks session status=DISCARDED, no message sent to joint chat
- Draft Coach conversation is private to the drafting user — draftCoach/session enforces userId match
- All functions enforce auth + party-to-case check

### T34: Draft coach AI action — generateResponse with readiness detection

**Type:** Task

**Summary:** Implement the draftCoach/generateResponse action from TechSpec §6.3.4. Exploratory back-and-forth conversation helping the user craft a message. Detects readiness signals ('i'm ready', 'draft it', 'write the message', or 'Generate Draft' button canonical message) and produces a structured output with the polished draft. Draft Coach context includes user's joint-chat history + their own synthesis, NOT the other party's data.

**Depends on:** T33, T5, T7, P0.2

**Acceptance Criteria:**

- Action uses DRAFT_COACH role via prompt assembly module
- Context includes drafting user's joint-chat history + their own synthesis; does NOT include other party's synthesis or private content per TechSpec §6.3.4
- Category-specific template instructions applied if available
- Readiness detection: inspects each user turn for signals per TechSpec §6.3.4 — 'i'm ready', 'draft it', 'write the message', 'looks good, write it', or canonical 'Generate Draft' button message
- On readiness: produces structured output with finalDraft field, writes to draftSession.finalDraft via mutation
- Non-readiness turns: exploratory coaching (asks about intent, tone, framing) — not a single-shot rewrite
- Streaming: inserts draftMessages row with status=STREAMING, batched token updates, final COMPLETE status
- Generating the draft does NOT send it — the UI handles the send gate per US-12 hard rule
- On AI failure: retry once, then mark message as ERROR with Retry button

### T35: DraftCoachPanel component — side panel with send gate

**Type:** Story

**Summary:** Build the Draft Coach panel per DesignDoc §4.10 and StyleGuide §6.9. Right-side sheet (420px wide on desktop, bottom sheet on mobile) with private coaching conversation, and when draft is ready, a DraftReadyCard showing the polished draft with Send/Edit/Continue/Discard buttons. Critically, only the 'Send this message' button posts to joint chat.

**Depends on:** T33, T34, T10

**Acceptance Criteria:**

- Panel slides in from right, 420px wide on desktop, full-height, shadow-3 per StyleGuide §6.9
- Mobile: becomes full-screen bottom sheet per DesignDoc §4.9
- Header: Sparkles icon (--coach-accent), 'Draft Coach' title, Lock icon, close button per StyleGuide §6.9
- Private banner directly under header: 'This is private to you. [Name] can't see what you're discussing here.'
- Chat uses same message bubbles at 14px font size (narrower surface) per StyleGuide §6.9
- User can type messages to Draft Coach and iterate; Draft Coach asks clarifying questions
- 'Draft it for me' button at bottom triggers readiness signal
- When draft is ready: DraftReadyCard renders the polished draft in a quoted card with 4 action buttons: 'Send this message' (primary), 'Edit before sending' (secondary), 'Keep refining with Coach' (ghost), 'Discard' (ghost/danger)
- 'Send this message' calls draftCoach/sendFinalDraft which posts to joint chat — this is the ONLY way the draft reaches joint chat
- 'Edit before sending' drops draft into joint chat input and closes panel
- 'Keep refining with Coach' continues the coaching conversation
- 'Discard' calls draftCoach/discardSession and closes panel
- Lock icon hover tooltip: 'Jordan can't see any of this. Only the final message you send goes to the joint chat.'
- Focus moves to textarea on panel open per DesignDoc §7.2
- AI error messages render inline with ERROR styling and Retry button per NFR-RELIABILITY

### T36: Closure UI — proposal modal + confirmation banner

**Type:** Story

**Summary:** Build the case closure flow per DesignDoc §4.11. 'Close' button in joint chat nav opens a modal with Resolved/Not resolved/Take a break options. Resolved requires a summary textarea and sends to the other party for confirmation. A confirmation banner appears for the other party with Confirm/Reject buttons.

**Depends on:** T30, T8

**Acceptance Criteria:**

- Close button in joint chat top nav opens closure modal per DesignDoc §4.11
- Modal options: 'Resolved' (primary flow), 'Not resolved' (warning), 'Take a break' (close tab, case stays JOINT_ACTIVE)
- Resolved: textarea 'Briefly describe what you agreed to' (required, 5 rows), message 'Jordan will see this summary and confirm', 'Propose Resolution' / 'Cancel' buttons
- 'Propose Resolution' calls jointChat/proposeClosure mutation
- Not resolved: warning styling, optional textarea, 'This closes the case immediately for both of you. Jordan will be notified.', 'Close without resolution' / 'Cancel' buttons
- 'Close without resolution' calls jointChat/unilateralClose mutation
- Confirmation banner shown to the other party when closure proposed: summary text, 'Confirm' / 'Reject and keep talking' buttons per DesignDoc §4.11
- Confirm calls jointChat/confirmClosure mutation → case transitions to CLOSED_RESOLVED
- Reject clears the closure proposal, optionally posts a message to the other party
- Modal uses styled Dialog component (not browser confirm()), max-width 480px, radius 20px per StyleGuide §6.12

### T37: ClosedCaseView page — read-only archive

**Type:** Story

**Summary:** Build the closed case view per DesignDoc §4.12. Shows case header with outcome (Resolved/Not Resolved/Abandoned), closure summary if resolved, full joint chat transcript (read-only), tabs for Joint Chat / My Private Coaching / My Guidance. Never shows other party's private coaching or synthesis.

**Depends on:** T30, T8, T10

**Acceptance Criteria:**

- Header: case name, category, closure date, outcome (Resolved / Not Resolved / Abandoned)
- If Resolved: closure summary prominently displayed per DesignDoc §4.12
- Full joint chat transcript rendered read-only (no input bar)
- Nav tabs: 'Joint Chat' | 'My Private Coaching' (only caller's messages) | 'My Guidance' (caller's synthesis)
- Banner: 'This case is closed. No new messages can be added.'
- Other party's private coaching and synthesis are NEVER shown, even after closure per DesignDoc §4.12
- Case remains accessible from Dashboard closed section

### T38: Admin Convex module — template CRUD, versioning, audit log writes

**Type:** Task

**Summary:** Implement the admin domain functions from TechSpec §7.1-7.2: admin/templates/listAll query (includes archived), admin/templateVersions/list query, admin/templates/create mutation, admin/templates/publishNewVersion mutation (creates immutable version, updates currentVersionId), admin/templates/archive mutation (soft-delete). All admin operations write to the auditLog table.

**Depends on:** T1, T3, T4

**Acceptance Criteria:**

- admin/templates/listAll query returns all templates including archived ones, admin-only (requireAdmin enforced server-side)
- admin/templateVersions/list query returns all versions for a template sorted by version number descending
- admin/templates/create mutation creates template + initial version (v1), records audit log entry with action=TEMPLATE_CREATED
- admin/templates/publishNewVersion mutation creates a new immutable templateVersions row with monotonic version number, updates template.currentVersionId, records audit log entry with action=TEMPLATE_PUBLISHED
- Existing cases pinned to old template versions are unaffected by new version publication
- admin/templates/archive mutation sets archivedAt timestamp, records audit log entry with action=TEMPLATE_ARCHIVED
- Archived templates disappear from category picker but remain resolvable by pinned cases per US-14 AC
- All mutations verify user.role === 'ADMIN' server-side; non-admin calls throw FORBIDDEN
- Audit log records: actorUserId, action, targetType, targetId, metadata, createdAt for every admin operation

### T39: Admin templates list page

**Type:** Story

**Summary:** Build the admin templates list page per DesignDoc §4.13. Table showing Category, Name, Current Version, Status (Active/Archived), Pinned Cases Count. '+ New Template' button. Click row navigates to template edit view. Gated by admin role check.

**Depends on:** T38, T8

**Acceptance Criteria:**

- Route /admin/templates accessible only to users with role=ADMIN; non-admin users redirected to /dashboard
- Table columns: Category, Name, Current Version (number), Status (Active/Archived badge), Pinned Cases Count
- '+ New Template' button opens creation form (can be inline or separate view)
- Click on table row routes to /admin/templates/:id (edit view)
- Archived templates visually distinguished (muted/grayed styling)
- Empty state: 'No templates yet. The app will use a built-in default baseline.' per DesignDoc §6.4

### T40: Admin template edit page — two-pane editor with version history

**Type:** Story

**Summary:** Build the template edit page per DesignDoc §4.13. Left pane: current draft form (category, name, globalGuidance, coachInstructions, draftCoachInstructions, notes). Right pane: version history timeline with each published version showing date, admin, notes, and 'View' button. 'Publish New Version' primary button and 'Archive Template' danger button.

**Depends on:** T38, T8

**Acceptance Criteria:**

- Two-pane layout: left (form), right (version history timeline) per DesignDoc §4.13
- Form fields: Category (select), Name (text), Global Guidance (large textarea, markdown), Coach Instructions (textarea), Draft Coach Instructions (textarea), Notes (textarea, admin-only changelog)
- Version history timeline: each published version shows date, admin name, notes, 'View' button for read-only diff
- 'Publish New Version' primary button creates immutable version via admin/templates/publishNewVersion mutation
- 'Archive Template' danger button with confirmation modal showing count of pinned cases; calls admin/templates/archive mutation
- Form pre-populated with current version's content when editing
- Route /admin/templates/:id accessible only to admin users

### T41: Admin audit log page

**Type:** Story

**Summary:** Build the audit log page per DesignDoc §4.13. Filterable table showing Actor, Action, Target, Timestamp. Click row opens JSON payload in a drawer. Read-only, not editable.

**Depends on:** T38, T8

**Acceptance Criteria:**

- Route /admin/audit accessible only to admin users
- Table columns: Actor (admin name/email), Action (e.g., TEMPLATE_PUBLISHED), Target (type + id), Timestamp
- Filterable by actor, action type, and date range
- Click on table row opens a right-side drawer showing the full audit log entry metadata as formatted JSON
- Table is read-only — no edit or delete capability
- Paginated or virtually scrolled for large audit logs

### T42: Abandoned case cron job (convex/crons.ts)

**Type:** Task

**Summary:** Implement the daily cron job from TechSpec §5.3 that scans for JOINT_ACTIVE cases with no activity in 30 days and transitions them to CLOSED_ABANDONED.

**Depends on:** T1, T2

**Acceptance Criteria:**

- convex/crons.ts defines a daily cron that runs the abandoned case scan
- Scan queries for cases with status=JOINT_ACTIVE and updatedAt older than 30 days
- Each matching case is transitioned to CLOSED_ABANDONED via the state machine helper
- Affected parties are notified via dashboard badge (no email in v1)
- Vitest unit test verifies: case with recent activity is NOT closed, case with 31-day-old activity IS closed

### T43: Landing page

**Type:** Story

**Summary:** Build the landing page per DesignDoc §4.1. Hero with tagline, three-step explainer (Private Coaching → Shared Conversation → Resolution), privacy section, footer with terms/privacy/contact. Primary CTA routes to login/register.

**Depends on:** T8, T9

**Acceptance Criteria:**

- Hero: single-sentence tagline ('A calm place to work through a difficult conversation.'), short subhead, 'Start a case' primary CTA
- Three-step explainer: Private Coaching → Shared Conversation → Resolution, minimal and iconographic
- Privacy section: 'Your words are yours. Here's how we protect them.' with link to privacy policy
- Footer: terms, privacy, contact links
- No testimonials, no repeated aggressive CTAs, no pricing per DesignDoc §4.1
- Logged-in users redirected to /dashboard
- Responsive: works on mobile per NFR-BROWSER targets
