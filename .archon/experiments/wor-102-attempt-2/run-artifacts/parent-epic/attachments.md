# Attachment Content

## 02-TechSpec.md

```
# Clarity — Technical Specification & Architecture
**Version 1.0 · May 2026 · Applied Labs (aplab.ai)**

> This document is a normative implementation brief. Every contract here is binding. An AI coding agent (e.g., Claude Code) should be able to implement the v1 app from this document alone.

---

## 1. System Overview

### 1.1 Architecture at a Glance

```
┌──────────────────────────────────────────────────────────────┐
│                    Client (React SPA)                        │
│   Vite + TS + Tailwind + shadcn/ui + Convex React client    │
└────────────────┬─────────────────────────────────────────────┘
                 │  Convex reactive queries (WebSocket)
                 │  Convex mutations & actions (RPC)
                 ▼
┌──────────────────────────────────────────────────────────────┐
│                       Convex Backend                         │
│  ┌────────────┐  ┌───────────┐  ┌───────────┐  ┌─────────┐   │
│  │ Database   │  │ Queries   │  │ Mutations │  │ Actions │   │
│  │ (document) │  │ (reactive)│  │ (txn'al)  │  │ (ext    │   │
│  │            │  │           │  │           │  │  API)   │   │
│  └────────────┘  └───────────┘  └───────────┘  └────┬────┘   │
│                                                      │        │
│  ┌─────────────────────────────────────────────┐     │        │
│  │ Convex Auth (magic link + Google OAuth)     │     │        │
│  └─────────────────────────────────────────────┘     │        │
└──────────────────────────────────────────────────────┼────────┘
                                                       │
                                                       ▼
                                              ┌────────────────┐
                                              │ Anthropic API  │
                                              │ Claude Sonnet  │
                                              │ Claude Haiku   │
                                              └────────────────┘
```

### 1.2 Stack Decisions (Locked)

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Frontend | React 18 + Vite + TypeScript | Modern, fast dev loop, Convex-native bindings |
| Styling | styleCSS + shadcn/ui | Design-system-ready, accessible primitives |
| State | Convex React hooks + React Context | Reactive queries replace most state management |
| Routing | React Router v6 | Standard SPA routing |
| Backend | Convex | All-in-one: DB + functions + realtime + auth + file storage |
| Auth | Convex Auth (magic link + Google OAuth) | Integrated; Clerk is the swap-out plan if beta bugs bite |
| AI | Anthropic Claude via `@anthropic-ai/sdk` (Sonnet 4.5 + Haiku 4.5) | Best-in-class for coaching/facilitation quality |
| E2E Testing | Playwright | Covers critical path |
| Unit Testing | Vitest | Fast, Vite-native |
| Lint/Format | ESLint + Prettier | Standard |
| CI | GitHub Actions | Standard |

### 1.3 Out of Scope for v1
- RAG / vector search (transcripts fit in context; compression handles overflow)
- Self-hosted Convex (use managed cloud for v1)
- Offline / PWA mode
- Push notifications (email only, and only in v1.1)

---

## 2. Convex Function Model Primer

Convex has three function types, and correctly mapping our logic onto them is load-bearing:

- **Query** — reactive, pure read of the database. Clients auto-subscribe; results push updates. Used for: dashboard list, case detail, chat messages.
- **Mutation** — transactional write. Atomic; cannot call external APIs. Used for: create case, send message (to DB), mark phase complete.
- **Action** — non-transactional; CAN call external APIs (Claude). Runs in a separate execution context; calls mutations internally to persist results. Used for: any Claude API invocation.

### 2.1 Canonical Pattern: User Sends Message in Joint Chat

```
Client
  │  1. optimistic UI: render user's message immediately
  ▼
sendJointMessage (mutation)
  │  2. insert userMessage row with status=SENT
  │  3. schedule generateCoachResponse action
  ▼
generateCoachResponse (action)
  │  4. read context (query DB for transcript, both parties' private
  │     synthesized context, active template version)
  │  5. call Claude Sonnet with streaming
  │  6. insert coachMessage row via recordCoachMessage mutation
  │     (streaming: update a single row as tokens arrive)
  ▼
Any joint-chat query auto-updates on both clients
```

---

## 3. Data Model

All tables live in Convex. Convex tables are schemaless by default but we enforce a schema via `convex/schema.ts` (strongly recommended — gives type safety end-to-end).

### 3.1 Tables

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // --- Users (managed partly by Convex Auth) ---
  users: defineTable({
    email: v.string(),
    displayName: v.optional(v.string()),
    role: v.union(v.literal("USER"), v.literal("ADMIN")),
    createdAt: v.number(),
  }).index("by_email", ["email"]),

  // --- Cases ---
  cases: defineTable({
    schemaVersion: v.literal(1),
    status: v.union(
      v.literal("DRAFT_PRIVATE_COACHING"),   // initiator has created, invitee may or may not have joined
      v.literal("BOTH_PRIVATE_COACHING"),    // both parties in private coaching
      v.literal("READY_FOR_JOINT"),          // both marked PC complete; synthesis generated
      v.literal("JOINT_ACTIVE"),             // in joint chat
      v.literal("CLOSED_RESOLVED"),
      v.literal("CLOSED_UNRESOLVED"),
      v.literal("CLOSED_ABANDONED"),         // auto-closed after 30d inactivity
    ),
    isSolo: v.boolean(),                     // solo test mode
    category: v.string(),                    // "workplace" | "family" | "personal" | "contractual" | "other"
    templateVersionId: v.id("templateVersions"),
    initiatorUserId: v.id("users"),
    inviteeUserId: v.optional(v.id("users")),  // null until invite redeemed
    createdAt: v.number(),
    updatedAt: v.number(),
    closedAt: v.optional(v.number()),
    closureSummary: v.optional(v.string()),   // populated on resolution
  })
    .index("by_initiator", ["initiatorUserId"])
    .index("by_invitee", ["inviteeUserId"]),

  // --- Per-party state within a case ---
  partyStates: defineTable({
    caseId: v.id("cases"),
    userId: v.id("users"),
    role: v.union(v.literal("INITIATOR"), v.literal("INVITEE")),
    // Form fields
    mainTopic: v.optional(v.string()),
    description: v.optional(v.string()),
    desiredOutcome: v.optional(v.string()),
    // Phase state
    formCompletedAt: v.optional(v.number()),
    privateCoachingCompletedAt: v.optional(v.number()),
    synthesisText: v.optional(v.string()),   // generated post-private-coaching
    synthesisGeneratedAt: v.optional(v.number()),
    closureProposed: v.optional(v.boolean()),
    closureConfirmed: v.optional(v.boolean()),
  })
    .index("by_case", ["caseId"])
    .index("by_case_and_user", ["caseId", "userId"]),

  // --- Private coaching messages (per party, isolated) ---
  privateMessages: defineTable({
    caseId: v.id("cases"),
    userId: v.id("users"),                   // owner — only this user can read
    role: v.union(v.literal("USER"), v.literal("AI")),
    content: v.string(),
    status: v.union(v.literal("STREAMING"), v.literal("COMPLETE"), v.literal("ERROR")),
    tokens: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_case_and_user", ["caseId", "userId"])
    .index("by_case", ["caseId"]),           // used by server-side AI context assembly only; never exposed

  // --- Joint chat messages ---
  jointMessages: defineTable({
    caseId: v.id("cases"),
    authorType: v.union(v.literal("USER"), v.literal("COACH")),
    authorUserId: v.optional(v.id("users")), // null if authorType=COACH
    content: v.string(),
    status: v.union(v.literal("STREAMING"), v.literal("COMPLETE"), v.literal("ERROR")),
    // Metadata
    isIntervention: v.optional(v.boolean()), // coach intervention on inflammatory content
    replyToId: v.optional(v.id("jointMessages")),
    createdAt: v.number(),
  }).index("by_case", ["caseId"]),

  // --- Draft Coach sessions (private to drafter) ---
  draftSessions: defineTable({
    caseId: v.id("cases"),
    userId: v.id("users"),
    status: v.union(v.literal("ACTIVE"), v.literal("SENT"), v.literal("DISCARDED")),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    finalDraft: v.optional(v.string()),      // the send-ready text when user confirms
  })
    .index("by_case_and_user", ["caseId", "userId"]),

  draftMessages: defineTable({
    draftSessionId: v.id("draftSessions"),
    role: v.union(v.literal("USER"), v.literal("AI")),
    content: v.string(),
    status: v.union(v.literal("STREAMING"), v.literal("COMPLETE"), v.literal("ERROR")),
    createdAt: v.number(),
  }).index("by_draft_session", ["draftSessionId"]),

  // --- Invite tokens ---
  inviteTokens: defineTable({
    caseId: v.id("cases"),
    token: v.string(),                       // 32 chars, url-safe, generated crypto-random
    status: v.union(v.literal("ACTIVE"), v.literal("CONSUMED"), v.literal("REVOKED")),
    createdAt: v.number(),
    consumedAt: v.optional(v.number()),
    consumedByUserId: v.optional(v.id("users")),
  })
    .index("by_token", ["token"])
    .index("by_case", ["caseId"]),

  // --- Templates ---
  templates: defineTable({
    category: v.string(),
    name: v.string(),
    currentVersionId: v.optional(v.id("templateVersions")),
    archivedAt: v.optional(v.number()),
    createdAt: v.number(),
    createdByUserId: v.id("users"),
  }).index("by_category", ["category"]),

  templateVersions: defineTable({
    templateId: v.id("templates"),
    version: v.number(),                     // monotonic within template
    // Immutable content once published
    globalGuidance: v.string(),
    coachInstructions: v.optional(v.string()),
    draftCoachInstructions: v.optional(v.string()),
    publishedAt: v.number(),
    publishedByUserId: v.id("users"),
    notes: v.optional(v.string()),
  }).index("by_template", ["templateId"]),

  // --- Audit log ---
  auditLog: defineTable({
    actorUserId: v.id("users"),
    action: v.string(),                      // e.g. "TEMPLATE_PUBLISHED", "CASE_CLOSED"
    targetType: v.string(),                  // e.g. "templateVersion", "case"
    targetId: v.string(),                    // id as string
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  }).index("by_actor", ["actorUserId"]),
});
```

### 3.2 Key Invariants
1. `cases.templateVersionId` is set at case creation and **never changes**, even if the template is edited or archived later.
2. `privateMessages` for user A in case C are **never** returned by any query where the caller is not user A. Enforced in every query function.
3. `jointMessages` are visible only to users whose `partyStates` row exists for that case.
4. `inviteTokens.status` transitions `ACTIVE → CONSUMED` atomically within the redemption mutation. Re-redemption fails.
5. `templateVersions` rows are immutable once created. Publishing a new version means inserting a new row and updating `templates.currentVersionId`.
6. `cases.schemaVersion` is present on every case for forward migration support. v1 is always `1`.

---

## 4. Authentication & Authorization

### 4.1 Auth Provider
Use **Convex Auth** with two providers:
- Magic link (email-based one-time login link)
- Google OAuth

**Decision point (Q1 in PRD):** if Convex Auth beta bugs block us, swap to Clerk. The data model above is provider-agnostic (we keep our own `users` table; auth provider supplies the identity, we upsert on first login).

### 4.2 Identity Model
- Convex Auth manages tokens + session.
- `ctx.auth.getUserIdentity()` in every function returns the authenticated identity (or null).
- On first login, we upsert a row in our `users` table keyed by email (role defaults to `USER`).
- Promotion to `ADMIN` is a manual DB action in v1 (no self-serve admin claim).

### 4.3 Authorization Rules

Every query, mutation, and action starts with:

```ts
const identity = await ctx.auth.getUserIdentity();
if (!identity) throw new Error("UNAUTHENTICATED");
const user = await getUserByEmail(ctx, identity.email);
if (!user) throw new Error("USER_NOT_FOUND");
```

Then function-specific rules apply. Summary:

| Operation | Rule |
|-----------|------|
| Read own case | user is `initiatorUserId` OR `inviteeUserId` |
| Read own party state | user matches `partyStates.userId` |
| Read own private messages | user matches `privateMessages.userId` |
| Read joint messages | user is party to the case |
| Send joint message | user is party + case in `JOINT_ACTIVE` |
| Admin template CRUD | user.role == `ADMIN` |
| Redeem invite | authenticated + token is `ACTIVE` |

### 4.4 Invite Flow
1. Initiator creates case → mutation generates a token (`crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,'')`, trimmed to 32 chars).
2. Invite URL: `https://clarity.app/invite/{token}`.
3. Invited user lands on `/invite/{token}`:
   - If logged out: prompt to register/login; token stashed in URL/localStorage until auth completes.
   - If logged in: show case summary (category, initiator's display name, main topic as stated by initiator — nothing from initiator's private coaching), then "Accept" button.
4. On accept → mutation: validate token is `ACTIVE`, set `cases.inviteeUserId`, create `partyStates` row for invitee, mark token `CONSUMED`. All in one transaction.
5. Reusing a consumed token returns an error and offers login/go-to-dashboard options.

---

## 5. Case Lifecycle State Machine

### 5.1 States & Transitions

```
                ┌─────────────────────────────┐
                │  DRAFT_PRIVATE_COACHING     │  ← created by initiator
                │  (initiator in PC)          │
                └────────┬────────────────────┘
                         │ invitee accepts invite + completes form
                         ▼
                ┌─────────────────────────────┐
                │  BOTH_PRIVATE_COACHING      │
                │  (both parties in PC)       │
                └────────┬────────────────────┘
                         │ both parties mark PC complete
                         │ + synthesis generated (atomic)
                         ▼
                ┌─────────────────────────────┐
                │     READY_FOR_JOINT         │
                └────────┬────────────────────┘
                         │ first party enters joint chat
                         ▼
                ┌─────────────────────────────┐
                │      JOINT_ACTIVE           │
                └──┬─────┬──────┬─────────────┘
                   │     │      │
          closure  │     │      │ 30d inactivity
          resolved │     │      │ (scheduled)
                   ▼     │      ▼
           CLOSED_RESOLVED│  CLOSED_ABANDONED
                         │
                         │ unilateral close
                         ▼
                  CLOSED_UNRESOLVED
```

### 5.2 Transition Rules
- Transitions are **server-enforced**. Client never sets `status` directly.
- Each transition is a dedicated mutation that validates the preconditions and updates atomically.
- Closure requires explicit confirmation:
  - Party A proposes (sets `partyStates.closureProposed = true`, stores proposed summary on case)
  - Party B confirms (sets `closureConfirmed = true`) → case moves to `CLOSED_RESOLVED`
  - Either party can reject; proposer flag clears
- `CLOSED_UNRESOLVED` requires only one party's action + a mandatory 24h cooling-off (not implemented in v1 — flagged as v1.1).
  - **v1 simplification:** unilateral close is immediate; the other party is notified via dashboard badge.
- `CLOSED_ABANDONED` is set by a scheduled job (Convex cron) that looks for `JOINT_ACTIVE` cases with no activity in 30 days.

### 5.3 Convex Scheduling
Use Convex's built-in scheduler:
- Daily cron (`convex/crons.ts`) scans for abandoned cases.
- After synthesis generation, schedule no action — the state moves to `READY_FOR_JOINT` synchronously within the mutation that generates the synthesis, unless synthesis is async (see §6.3 — it IS async, via an action, so the action re-enters and writes state on completion).

---

## 6. AI Integration

### 6.1 Provider & Models
- **Provider:** Anthropic, via `@anthropic-ai/sdk`.
- **Models:**
  - `claude-sonnet-4-5` — Private Coach, Coach, Draft Coach, Synthesis. All user-facing generation.
  - `claude-haiku-4-5-20251001` — Inflammatory content classification, cheap classification tasks.
- **API key:** stored in Convex environment variable `ANTHROPIC_API_KEY`. Never exposed to client.

### 6.2 Streaming
All user-facing AI responses stream. Implementation:
1. Action inserts a `_Messages` row with `status: "STREAMING"` and empty content.
2. Action calls Claude with `stream: true`.
3. As tokens arrive, action calls a mutation every ~50ms-worth of tokens (batched) to update the row's content.
4. Client's reactive query auto-updates the UI as the row changes.
5. On completion, final mutation sets `status: "COMPLETE"` and records total tokens.

### 6.3 The Three AI Roles — Contracts

All roles use a common prompt-assembly function:

```ts
function assemblePrompt(opts: {
  role: "PRIVATE_COACH" | "COACH" | "DRAFT_COACH" | "SYNTHESIS";
  caseId: Id<"cases">;
  actingUserId: Id<"users">;
  recentHistory: Message[];
  templateVersion?: TemplateVersion;
}): { system: string; messages: Message[] }
```

#### 6.3.1 Private Coach
- **Template applied:** NONE. Private coaching is an open, general-purpose AI conversation per the story doc §5.
- **System prompt (runtime default, hardcoded):**
  > "You are a calm, curious, non-judgmental listener helping a person articulate their perspective in an interpersonal conflict. Ask clarifying questions. Reflect what they say. Help them identify what they actually want, what they're feeling, and what the other person might be thinking. Do not take sides. Do not tell them they're right or wrong. Your only goal is to help them prepare to communicate with the other party clearly and calmly."
- **Context injected:** this party's form fields (main topic, description, desired outcome) + full prior private message history for this party + case.
- **Forbidden:** the other party's private content. This prompt is called with a context that does NOT include the other party's data. Strict isolation.

#### 6.3.2 Synthesis (one-shot, non-streaming)
- **Trigger:** both parties have marked private coaching complete.
- **System prompt:** instructs the model to output **two** independent synthesis texts, one per party, each containing:
  1. Areas of likely agreement
  2. Genuine points of disagreement
  3. Suggested communication approaches for the joint session
- **Critical instruction (verbatim in prompt):**
  > "You have access to both parties' private content for context. In your outputs, NEVER quote, closely paraphrase, or otherwise surface the other party's raw words. Synthesize themes and positions in your own words only. If you cannot make a point without quoting, omit it."
- **Output format:** strict JSON, validated server-side:
  ```json
  { "forInitiator": "...", "forInvitee": "..." }
  ```
- **Response filter (server-side enforcement):**
  - Tokenize the other party's private messages.
  - For each synthesis text, check for any substring ≥ 8 consecutive tokens matching any private message.
  - If match found: re-generate (up to 2 retries). If still matching: return a generic fallback synthesis + flag for admin review.
- **Persistence:** write to `partyStates.synthesisText` + `synthesisGeneratedAt`. Set `case.status = READY_FOR_JOINT` in same mutation.

#### 6.3.3 Coach (joint chat facilitator)
- **Template applied:** category-specific template if available, else default baseline. Baseline only establishes role, no methodology — per story doc §5.1.
- **Invoked:**
  - On every new user joint message (to decide: intervene? summarize? stay quiet?)
  - On @-mention by a party
  - On a timer (if 5+ exchanges with no Coach input)
- **Context:** joint chat history + BOTH parties' synthesis texts (NOT raw private messages — the synthesis is already privacy-scrubbed).
- **Hard rule:** Coach output must not quote or closely paraphrase content from either party's raw private messages. Enforcement: same response filter as synthesis.
- **"Should I speak?" gate (uses Haiku):** before Sonnet is called, Haiku classifies the last user message as one of: `INFLAMMATORY`, `PROGRESS`, `QUESTION_TO_COACH`, `NORMAL_EXCHANGE`. Coach only generates a message for non-`NORMAL_EXCHANGE` unless a timer fires.

#### 6.3.4 Draft Coach
- **Template applied:** category-specific template if available, else default baseline.
- **Conversation loop:** Draft Coach is a short, exploratory chat with the drafting user. It asks clarifying questions about intent, surfaces tone issues, and only generates a polished draft when the user signals readiness.
- **Readiness signal:** the action inspects each user turn; if the user message matches any of `["i'm ready", "draft it", "write the message", "looks good, write it", …]` or clicks a "Generate Draft" button that posts a canonical user message, Draft Coach responds with a structured output: `{ "draft": "...polished message..." }`.
- **Send gate:** generating the draft does NOT send it. The UI shows the draft with Send / Edit / Continue refining / Discard buttons. Only Send triggers the `sendJointMessage` mutation.
- **Privacy:** Draft Coach context includes the drafting user's joint-chat history (they're a party, they've already seen it) + their own synthesis. It does NOT include the other party's synthesis or private content. This keeps one party from probing the other's position through Draft Coach.

### 6.4 Transcript Compression
When the total token count of messages in the context window would exceed a budget (default **60k tokens for user-facing generation, 10k for classification**):
1. Take the oldest 50% of messages.
2. Call Haiku with a compression prompt: "Summarize this conversation segment in 500 tokens or fewer, preserving facts, decisions, emotional tone, and unresolved threads."
3. Replace those messages in the context with a single synthetic "SUMMARY:" message.
4. Cache the summary by content hash; reuse if the same segment is compressed again.

This is ported from the existing prototype's approach and is deliberately deterministic — no vector search, no RAG, nothing clever.

### 6.5 AI Error Handling
| Failure | Behavior |
|---------|----------|
| Rate limit (429) | Retry once with 2s backoff; if still fails, surface error + Retry button |
| Network timeout (>30s) | Mark message as ERROR, show Retry button |
| Invalid API key / 401 | Log + surface generic "Coach is unavailable" error; alert ops via audit log |
| Content filtered by Anthropic | Show generic "Coach can't respond to that" + encourage rephrase |
| Response filter rejects output (privacy leak detected) | Retry generation up to 2x; on final failure, show generic fallback + flag for review |

### 6.6 Cost Budget
- Per-case soft cap: **$2 in v1**. Tracked via token counts × Anthropic pricing.
- At cap: inflammatory classification continues (cheap); Coach responses degrade to templated boilerplate ("I'm limited right now — consider summarizing where you are and whether you've reached agreement"). Admin notified.
- Hard cap: **$10**, after which the case is marked `COST_LIMITED` and AI features are fully disabled; parties can still exchange messages manually but no Coach, Draft Coach, or synthesis.

---

## 7. API Surface (Convex Functions)

All functions live under `convex/`. Naming convention: `<domain>/<action>`.

### 7.1 Queries (reactive reads)

| Path | Input | Returns | Auth |
|------|-------|---------|------|
| `cases/list` | `{}` | `Case[]` (current user's) | authed |
| `cases/get` | `{ caseId }` | `Case \| null` | party to case |
| `cases/partyStates` | `{ caseId }` | `{ self: PartyState, otherPhaseOnly: { status, hasCompletedPC } }` | party to case |
| `privateCoaching/myMessages` | `{ caseId }` | `PrivateMessage[]` (only caller's) | party to case |
| `jointChat/messages` | `{ caseId }` | `JointMessage[]` | party to case + case not in private-only state |
| `jointChat/mySynthesis` | `{ caseId }` | `{ text: string } \| null` | party to case |
| `draftCoach/session` | `{ caseId }` | `{ session, messages } \| null` | party to case |
| `templates/list` | `{ category? }` | `Template[]` (non-archived) | authed |
| `admin/templates/listAll` | `{}` | `Template[]` incl. archived | admin |
| `admin/templateVersions/list` | `{ templateId }` | `TemplateVersion[]` | admin |

### 7.2 Mutations (transactional writes)

| Path | Input | Effect |
|------|-------|--------|
| `cases/create` | `{ category, mainTopic, description, desiredOutcome, templateId?, isSolo? }` | Creates case + initiator `partyStates` + invite token (or pre-bound invitee for solo); returns `caseId` + invite URL |
| `invites/redeem` | `{ token }` | Binds current user as invitee, creates their `partyStates` row, marks token consumed |
| `cases/updateMyForm` | `{ caseId, mainTopic, description, desiredOutcome }` | Updates caller's `partyStates` form fields |
| `privateCoaching/sendUserMessage` | `{ caseId, content }` | Inserts user message + schedules AI action |
| `privateCoaching/markComplete` | `{ caseId }` | Sets caller's `privateCoachingCompletedAt`; if both complete, schedules synthesis |
| `jointChat/sendUserMessage` | `{ caseId, content }` | Inserts user joint message (from Draft Coach Send button) + schedules Coach evaluation |
| `jointChat/proposeClosure` | `{ caseId, summary }` | Marks caller's `closureProposed`; records summary |
| `jointChat/confirmClosure` | `{ caseId }` | If other party has proposed, closes case as RESOLVED |
| `jointChat/unilateralClose` | `{ caseId, reason }` | Closes as UNRESOLVED |
| `draftCoach/startSession` | `{ caseId }` | Creates `draftSessions` row; returns id |
| `draftCoach/sendMessage` | `{ sessionId, content }` | Inserts user draft message + schedules Draft Coach action |
| `draftCoach/sendFinalDraft` | `{ sessionId }` | Reads `finalDraft`, calls `jointChat/sendUserMessage` internally, marks session `SENT` |
| `draftCoach/discardSession` | `{ sessionId }` | Marks session `DISCARDED` |
| `admin/templates/create` | `{ category, name, globalGuidance, coachInstructions?, draftCoachInstructions? }` | Creates template + initial version |
| `admin/templates/publishNewVersion` | `{ templateId, globalGuidance, … }` | Creates new templateVersion, updates template.currentVersionId |
| `admin/templates/archive` | `{ templateId }` | Sets `archivedAt`; existing cases unaffected |

### 7.3 Actions (external API calls)

| Path | Input | Effect |
|------|-------|--------|
| `privateCoaching/generateAIResponse` | `{ caseId, userId }` | Calls Claude, streams into `privateMessages` |
| `synthesis/generate` | `{ caseId }` | Calls Claude, validates output, writes synthesis for both parties, advances state |
| `jointChat/generateCoachResponse` | `{ caseId, triggerType }` | Haiku gate → optional Sonnet call → streams into `jointMessages` |
| `draftCoach/generateResponse` | `{ sessionId }` | Calls Claude, streams into `draftMessages`. If readiness detected, produces `finalDraft`. |

### 7.4 Error Codes
Normalize all thrown errors to a small set (wrap in a `ConvexError` with a shape: `{ code, message, httpStatus }`).

| Code | Meaning |
|------|---------|
| `UNAUTHENTICATED` | No valid session |
| `FORBIDDEN` | Authed but not allowed to access resource |
| `NOT_FOUND` | Resource missing |
| `CONFLICT` | State transition not allowed (e.g., send joint message when case not JOINT_ACTIVE) |
| `INVALID_INPUT` | Validation failed |
| `TOKEN_INVALID` | Invite token not active |
| `RATE_LIMITED` | Upstream rate limit hit |
| `AI_ERROR` | Upstream AI error (with subcategory in message) |
| `INTERNAL` | Unexpected server failure |

---

## 8. Real-Time Layer

### 8.1 How It Works
- Convex reactive queries ARE the real-time layer.
- Client subscribes via `useQuery` hook; Convex pushes updates on any underlying table change.
- For joint chat: both clients subscribe to `jointChat/messages`. Server mutation inserts a message → both clients receive an update.
- No separate WebSocket layer, no pub/sub, no polling.

### 8.2 Streaming Updates
When an AI action updates a streaming row ~20 times/second during generation, each update triggers a reactive push. This is fine at this scale but worth knowing. If perf becomes an issue in v1.1, batch updates to 200ms intervals.

### 8.3 Presence (Deferred to v1.1)
"Other party is typing" / "Other party is online" indicators are deferred. The story doc lists typing indicators as prototype UX but they're nice-to-have for v1.

---

## 9. Frontend Architecture

### 9.1 Structure
```
src/
  main.tsx                 // React + ConvexProvider + AuthProvider
  App.tsx                  // Routes
  routes/
    LandingPage.tsx
    LoginPage.tsx
    InviteAcceptPage.tsx
    Dashboard.tsx
    NewCasePage.tsx
    CaseDetail.tsx         // orchestrates phase-appropriate subview
    PrivateCoachingView.tsx
    ReadyForJointView.tsx  // shows synthesis, "Enter Joint Chat" CTA
    JointChatView.tsx
    ClosedCaseView.tsx
    admin/
      TemplatesListPage.tsx
      TemplateEditPage.tsx
      AuditLogPage.tsx
  components/
    chat/
      ChatWindow.tsx
      MessageBubble.tsx
      MessageInput.tsx
      StreamingIndicator.tsx
    draft/
      DraftCoachPanel.tsx
      DraftReadyCard.tsx
    layout/
      TopNav.tsx
      PartyToggle.tsx      // solo mode
    ui/                    // shadcn/ui primitives
  lib/
    convex.ts
    auth.ts
    formatting.ts
  hooks/
    useCurrentUser.ts
    useCurrentCase.ts
    useSoloActingParty.ts
```

### 9.2 Route Map
```
/                           Landing (logged out) or redirect to /dashboard
/login                      Magic link / Google OAuth
/invite/:token              Invite acceptance
/dashboard                  Case list
/cases/new                  Case creation form
/cases/:caseId              Case detail — routes internally by status
/cases/:caseId/private      Private coaching
/cases/:caseId/joint        Joint chat
/cases/:caseId/closed       Read-only closed view
/admin/templates            Admin list
/admin/templates/:id        Admin edit
/admin/audit                Admin audit log
```

### 9.3 Solo Mode Party Toggle
- A case where `isSolo == true` has a `PartyToggle` in the top nav.
- Toggle state stored in URL query param `?as=initiator|invitee` (so refresh preserves it).
- Hooks (`useActingPartyUserId`) read the toggle and pass the correct userId to queries.
- All data queries respect the toggle — the UI effectively simulates two sessions in one browser.

### 9.4 Streaming UI
- Each chat message row renders differently by `status`:
  - `STREAMING` → render content + blinking cursor; no copy button yet
  - `COMPLETE` → full render + copy button + timestamp
  - `ERROR` → error styling + Retry button
- Auto-scroll to latest message UNLESS user has scrolled up (detect via scroll position).

### 9.5 Accessibility
- `<main>`, `<nav>`, `<aside>` landmarks.
- Chat messages in `role="log"` with `aria-live="polite"` for new messages.
- All buttons have visible labels OR `aria-label`.
- Focus management: when a new phase opens (private coaching → joint chat), focus moves to the new primary heading.
- Playwright tests include a keyboard-only run of the critical path.

---

## 10. Testing Strategy

### 10.1 Playwright E2E (critical path)
Test suite lives under `e2e/`. Suites:

1. **`auth.spec.ts`**
   - Register new user via magic link (mock email capture)
   - Log out, log back in
   - Google OAuth (mocked)

2. **`solo-full-flow.spec.ts`** (highest-value test — solo mode runs the whole flow in one browser session)
   - Create solo case
   - Toggle to Initiator, do private coaching, mark complete
   - Toggle to Invitee, do private coaching, mark complete
   - Synthesis appears for both
   - Enter joint chat
   - Exchange messages with Draft Coach in the loop
   - Propose + confirm closure
   - Case shows in Closed section

3. **`invite-flow.spec.ts`**
   - Two browser contexts (two users)
   - User A creates case, copies invite link
   - User B opens link, registers, accepts
   - Both see case in their dashboards

4. **`draft-coach.spec.ts`**
   - Start a draft session
   - Iterate with Draft Coach
   - Verify that clicking "Generate Draft" does NOT send
   - Verify that only clicking "Send" posts to joint chat
   - Discard a draft, verify it doesn't appear

5. **`privacy.spec.ts`** (security test)
   - As user B, attempt to read user A's private messages via direct query (via Convex client dev mode) — must return FORBIDDEN
   - As an admin, attempt same — must return FORBIDDEN (admin has no cross-party read)
   - Inflammatory joint message test: verify Coach response does NOT contain any 8-token substring from the other party's private messages

6. **`admin-templates.spec.ts`**
   - Admin creates template, publishes version
   - Edit publishes v2; pinned case still uses v1
   - Archive template, verify it's hidden from category picker but pinned cases still work

7. **`state-machine.spec.ts`**
   - Attempt illegal transitions (send joint message when case in private coaching) — must fail CONFLICT
   - Attempt to mark PC complete twice — idempotent, no error
   - Attempt to redeem consumed token — TOKEN_INVALID

### 10.2 Unit Tests (Vitest)
- Pure helper functions: prompt assembly, transcript compression, token counting, synthesis validator
- Privacy response filter: given a set of "other party" messages and a candidate response, detect/miss correctly
- Invite token generator: uniqueness, url-safety

### 10.3 CI Pipeline
GitHub Actions workflow:
- `lint` (ESLint + Prettier check)
- `typecheck` (tsc --noEmit)
- `unit` (vitest)
- `e2e` (Playwright; uses a Convex dev deployment spun up per run with seeded admin user + mocked Claude API)

### 10.4 Mocking Claude in Tests
- E2E: use a test-mode env var `CLAUDE_MOCK=true` that makes the action call a deterministic stub responder rather than the real API. Stub returns canned responses with configurable delays to simulate streaming.
- Unit: direct mock of the SDK.

---

## 11. Deployment & Environment

### 11.1 Environments
| Env | Convex Deployment | URL | Purpose |
|-----|-------------------|-----|---------|
| local | dev (per developer) | localhost:5173 | local dev |
| staging | `clarity-staging` | staging.clarity.app | CI + beta testers |
| production | `clarity-prod` | clarity.app | Live users |

### 11.2 Environment Variables
Convex deployment:
- `ANTHROPIC_API_KEY` (per env; prod has strict budget alerts)
- `CLAUDE_MOCK` (true in test only)
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
- `SITE_URL` (used in invite link generation)
- `MAGIC_LINK_EMAIL_FROM`

Client (Vite):
- `VITE_CONVEX_URL`
- `VITE_SITE_URL`

### 11.3 Cold-Start Local Dev
```
git clone <repo>
cd clarity
npm install
cp .env.example .env.local
# fill in VITE_CONVEX_URL after convex dev starts
npx convex dev
npm run dev
```

One of the Launch Criteria (PRD §7.1) is that this exact sequence gets a developer to a working app. The README must match.

### 11.4 Seed Data
`convex/seed.ts` (admin-callable in dev only):
- Creates one admin user
- Creates 3 default templates: `workplace`, `family`, `personal` — each with a minimal globalGuidance

---

## 12. Security & Privacy Enforcement Checklist

This is the concrete implementation of PRD §6.

- [ ] Every query/mutation/action begins with identity check
- [ ] `privateMessages` reads enforce `userId == callerUserId`
- [ ] `jointMessages` reads enforce caller is party to the case
- [ ] No query returns fields from another user's `partyStates` beyond phase-level booleans
- [ ] Synthesis action's response filter is tested (unit test with adversarial prompts)
- [ ] Coach action's response filter is tested likewise
- [ ] AI system prompts contain explicit no-quote rule
- [ ] Admin role check is server-side every time (no client flag trust)
- [ ] Invite tokens are crypto-random (32 url-safe chars), single-use, stored as hash in DB (store raw for simplicity in v1 — acceptable since consumption is instant and token has no post-use value)
- [ ] Solo mode cases are visibly flagged in admin/audit views to prevent them being confused with real user data
- [ ] All audit-relevant admin actions write to `auditLog`
- [ ] ToS + privacy policy linked from every auth screen and case creation screen
- [ ] "Not for crisis / abuse situations" language in ToS + surfaced on case creation

---

## 13. Open Technical Questions

| # | Question | Proposed Default | Decision Path |
|---|----------|------------------|---------------|
| TQ1 | Convex Auth vs. Clerk? | Start with Convex Auth; measure bug pain in Phase 1 | Eng lead during Phase 1 |
| TQ2 | Response filter: token-substring vs. embedding-similarity? | Token substring (≥ 8 contiguous tokens) for v1. Simpler, deterministic. Add embedding similarity if false-negatives found. | Eng during Phase 2 |
| TQ3 | Do we stream synthesis generation, or one-shot? | One-shot, non-streaming. Synthesis is generated once per case at a gate; a brief "Generating your guidance…" loading state is fine. | Locked by this doc |
| TQ4 | How do we handle session resumption mid-streaming AI response if the user closes the tab? | The streaming message row stays in DB; when the tab reopens, the reactive query shows the final state. No resume logic needed. | Locked |
| TQ5 | Rate limiting at the app level (abuse protection)? | Convex has built-in per-user function rate limits. Tune during beta. | Ops during Phase 4 |
| TQ6 | Message deletion / edit? | Not in v1. Messages are immutable. Flagged for v1.1. | Locked |

---

## 14. Implementation Notes for Claude Code (One-Shot Generation Aid)

If this spec is being fed to Claude Code for a one-shot build:

1. **Start with `convex/schema.ts`** — it's the source of truth and must match §3.1 exactly.
2. **Implement functions table-by-table, not route-by-route** — each Convex file is one domain (cases.ts, privateCoaching.ts, jointChat.ts, draftCoach.ts, templates.ts, invites.ts, admin.ts, synthesis.ts).
3. **Build the state machine in a single helper module** (`convex/stateMachine.ts`) — every mutation that transitions state calls it. Don't inline state logic.
4. **Prompt assembly is a single module** (`convex/lib/prompts.ts`) — every AI role goes through it.
5. **Build the privacy response filter before either Coach or Synthesis** — both depend on it.
6. **UI: build the shared ChatWindow component first** — Private Coaching, Joint Chat, and Draft Coach all use it (with different config).
7. **Solo mode is a view-level feature, not a data-level one** — the DB doesn't care; the UI just lets one user act as either party. Build all paths single-user first; add the toggle last.
8. **Ship Playwright's `solo-full-flow.spec.ts` first** — it's the fastest end-to-end smoke test and will reveal integration bugs before user-facing polish.
9. **Do NOT build admin UI before the core flow works** — admin is P1; templates can be seeded and edited directly in Convex Dashboard during Phase 1.
10. **Commit after each section** — small, reviewable units beat one monster PR.

---

*Clarity · Tech Spec v1.0 · Applied Labs · May 2026*

```

## 03-DesignDoc.md

```
# Clarity — Design Document
**Version 1.0 · May 2026 · Applied Labs (aplab.ai)**

> This document defines the visual language, interaction patterns, navigation, and screen-by-screen UX for Clarity v1. It pairs with the PRD (product intent) and Tech Spec (how it works under the hood).

---

## 1. Design Principles

Five principles govern every design decision in Clarity. When in doubt, defer to them in this order:

### 1.1 Calm over Clever
The product exists because the people using it are stressed, frustrated, or hurt. The interface must feel like a deep breath, not a productivity app. No aggressive colors, no gamification, no celebration animations on "conflict resolved." Reserved, considered, gentle.

### 1.2 The Human is the Decision-Maker
Every AI output is a suggestion. The user sends the message, marks the phase complete, confirms the closure. The UI must make the human's agency visually unmistakable — Send is always a human action, never automatic.

### 1.3 Privacy is Visible, Not Implied
If a screen contains private data, the screen says so. If the other party can't see something, the UI labels it "Private to you." Trust is earned by showing the seams, not hiding them.

### 1.4 One Primary Action per Screen
In a conflict, decision fatigue is already high. Each screen has one clear next step. Secondary actions are available but visually subordinated.

### 1.5 Presence over Polish
Real-time updates, streaming text, subtle activity indicators — these do more for trust than any amount of decorative polish. Invest visual budget in the moments of live interaction.

---

## 2. Visual Language

### 2.1 Color Palette

The palette is deliberately muted and warm. No saturated blues or reds. The default theme is light with a soft off-white canvas.

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-canvas` | `#FAF8F5` | Page background — warm off-white, low eye strain |
| `--bg-surface` | `#FFFFFF` | Cards, chat bubbles, panels |
| `--bg-surface-subtle` | `#F3EFE9` | Hover states, subtle sections |
| `--text-primary` | `#1F1D1A` | Body text |
| `--text-secondary` | `#5C5952` | Labels, metadata |
| `--text-tertiary` | `#8A8680` | Timestamps, hints |
| `--accent` | `#6B8E7F` | Primary actions — a sage green, calming, not commanding |
| `--accent-hover` | `#5A7A6C` | Primary hover |
| `--accent-subtle` | `#DCE7E0` | Accent backgrounds (mention chips, coach messages) |
| `--danger` | `#B5594D` | Destructive actions — muted terracotta, not red |
| `--danger-subtle` | `#F2DCD8` | Danger backgrounds |
| `--warning` | `#B58B4D` | Inflammatory-content coach intervention highlight |
| `--border-default` | `#E5E0D8` | Hairline borders, dividers |
| `--border-strong` | `#CBC4B8` | Input borders, strong dividers |
| `--coach-accent` | `#8B7AB5` | Coach AI identity — soft dusty lavender, distinct from user |
| `--private-tint` | `#F0E9E0` | Background tint for "this is private to you" panels |

Dark mode mirrors the palette with inverted luminance, preserving the same warm, low-saturation feeling.

### 2.2 Typography

- **Primary font:** Inter (variable) — 400 / 500 / 600 weights
- **Body:** 15px / 1.6 line-height (chat bubbles: 16px for readability)
- **Chat timestamps:** 12px, `--text-tertiary`
- **Headings:** 500 weight for H1/H2 (not 700) — this is not a marketing page, bold headings feel shouty
- **Mono:** JetBrains Mono (for invite links, audit log IDs)

### 2.3 Spacing & Layout
- 8px base grid. Common paddings: 8, 16, 24, 32, 48.
- Content max-width: 720px for reading-heavy screens (case forms, synthesis). 1080px for joint chat (more breathing room between message columns).
- Mobile breakpoint: < 768px — chat UI collapses Draft Coach panel to a bottom sheet.

### 2.4 Elevation
Shadows are subtle. Four levels:
- `shadow-0` — flat, borders only
- `shadow-1` — `0 1px 2px rgba(0,0,0,0.04)` — cards at rest
- `shadow-2` — `0 4px 12px rgba(0,0,0,0.06)` — popovers, dropdowns
- `shadow-3` — `0 12px 32px rgba(0,0,0,0.10)` — modals, Draft Coach panel

### 2.5 Iconography
Lucide icons, 1.5px stroke. Key icons:
- Lock (private content) — on every private-scoped panel
- Users (case with both parties)
- MessageCircle (chat)
- Sparkles (Draft Coach, synthesis)
- ShieldCheck (privacy reminders)
- Pause (case paused / awaiting other party)

### 2.6 Motion
- Transitions are short (150–200ms) and always `ease-out`.
- AI streaming: a subtle blinking cursor at the end of streaming text. No "typing" dots that bounce playfully — too chipper for the context.
- Route transitions: crossfade (100ms). No slide animations.
- New message arrival: fade-in + 8px upward translate (150ms).
- No celebration animation on case closure. The moment is quiet on purpose.

---

## 3. Navigation Architecture

### 3.1 Site Map

```
Logged out
├── /                         Landing (hero, how it works, CTA)
├── /login                    Magic link + Google OAuth
├── /invite/:token            Invite acceptance (auth if needed)
└── /about                    (v1.1)

Logged in
├── /dashboard                Cases list
├── /cases/new                Case creation form
├── /cases/:caseId            Redirects by status
│   ├── /private              Private coaching chat
│   ├── /ready                Synthesis + "Enter joint chat" CTA
│   ├── /joint                Joint chat (with Draft Coach)
│   └── /closed               Read-only archive
├── /profile                  Display name, email, sign-out
└── /admin/* (role=ADMIN)
    ├── /templates            List
    ├── /templates/:id        Edit + version history
    └── /audit                Audit log
```

### 3.2 Top Navigation

**Logged in (case-less pages — Dashboard, Profile):**
```
┌───────────────────────────────────────────────────────┐
│ Clarity                     [Dashboard] [◉ You]│
└───────────────────────────────────────────────────────┘
```

**Inside a case:**
```
┌────────────────────────────────────────────────────────────┐
│ ← Back to Dashboard │ Case with Jordan • Private Coaching │
└────────────────────────────────────────────────────────────┘
```

The case phase is always visible in the header — users should never wonder what phase they're in.

**Solo mode adds a party toggle:**
```
┌─────────────────────────────────────────────────────────────┐
│ ← Dashboard │ Solo Test Case │ Viewing as: [Alex ▾] [Jordan]│
└─────────────────────────────────────────────────────────────┘
```

The toggle is a prominent segmented control, colored `--coach-accent`, making the solo context unmistakable.

---

## 4. Screen-by-Screen Specifications

### 4.1 Landing Page (`/`)

**Purpose:** Convey the product in 15 seconds; convert to login.

**Layout:**
- Hero: single-sentence tagline ("A calm place to work through a difficult conversation."), short subhead, primary CTA "Start a case."
- Three steps explainer: Private Coaching → Shared Conversation → Resolution. Minimal, iconographic.
- Privacy section: "Your words are yours. Here's how we protect them." Links to privacy policy.
- Footer: terms, privacy, contact.

**Do NOT include:** testimonials (we don't have any in v1), aggressive "Get started free" repeated CTAs, pricing (no pricing in v1).

### 4.2 Login / Register (`/login`)

**Purpose:** Minimal-friction auth.

**Layout:**
- Single centered card, ~400px wide.
- Heading: "Sign in to Clarity"
- Email input + "Send magic link" button (primary)
- Divider: "or"
- "Continue with Google" button (secondary)
- Fine print: "By signing in, you agree to our Terms and Privacy Policy."

**States:**
- Default
- Magic link sent: replace form with a confirmation message ("Check your email…")
- Error: inline below the email input

**No password field.** Intentional — see PRD.

### 4.3 Invite Acceptance (`/invite/:token`)

**Purpose:** Bring the second party in warmly without revealing anything private.

**Layout (logged out):**
- Centered card.
- Heading: "Alex has invited you to work through something together."
- Body (exactly this shape): "Clarity is a private mediation tool. You'll each talk with an AI coach privately before having a facilitated conversation together."
- Button: "Sign in to continue"
- Token persists through auth.

**Layout (logged in, unredeemed):**
- Same framing, but adds:
  - "Alex says the conflict is about:" [initiator's main topic — ONE sentence as they wrote it]
  - "Category: Workplace" (or whichever)
  - [Accept invitation] [Decline]
- Decline → case is marked with `CLOSED_ABANDONED` + short explanation; initiator notified.

**Critical privacy callout:** Invitee sees only what the initiator wrote in the *shared* case form (mainTopic + category) — nothing from private coaching. This is visually labeled: "Alex wrote this in the shared summary. You'll have your own private space to share your perspective."

### 4.4 Dashboard (`/dashboard`)

**Purpose:** See all cases and get into the right one.

**Layout:**
- Top right: `[+ New Case]` primary button
- Section: "Active Cases" (cases not in CLOSED_* states)
- Section: "Closed Cases" (collapsed by default)

**Case row:**
```
┌───────────────────────────────────────────────────────────────┐
│ [icon] Case with Jordan                                      │
│        Workplace · Created Apr 15                             │
│        ● Private coaching — waiting on Jordan                 │
│        Last activity: 2 hours ago                   [Enter →] │
└───────────────────────────────────────────────────────────────┘
```

**Status indicator semantics:**
- `●` (green) — "Your turn" (action required)
- `○` (gray) — "Waiting on the other party"
- `◐` (amber) — "Ready to enter joint chat"
- `◼` (neutral) — Closed

This single-glyph system scales to mobile and avoids verbose status text.

**Empty state:** Friendly, not cutesy. "No cases yet. When you're ready to work through something, start a new case."

### 4.5 Case Creation Form (`/cases/new`)

**Purpose:** Structured intake that doesn't feel like a tax form.

**Layout (single-column, progressive disclosure):**

**Step 1 — Category** (radio cards, not dropdown; tactile choice)
- Workplace
- Family
- Personal relationship
- Contractual / business
- Other

**Step 2 — Main Topic**
- Label: "In one sentence, what's this about?"
- Helper: "This will be visible to the other person when they accept the invitation. Keep it factual, not emotional."
- Character counter (soft limit 140; allows over but discourages)

**Step 3 — Describe the Situation**
- Label: "Tell us more about what's going on."
- Helper: "**Private to you.** This helps the AI coach prepare, and the other person never sees it."
- Textarea, 5 rows, auto-grows.
- Privacy lock icon adjacent to the label, with tooltip: "Only you and the AI coach will see this."

**Step 4 — Desired Outcome**
- Label: "What would a good resolution look like for you?"
- Helper: "**Private to you.** It's okay if you're not sure — just a rough idea helps."
- Textarea, 3 rows.

**Step 5 — Who is this with?**
- Label: "What's their name?"
- Helper: "Just a first name or nickname is fine. You'll send them an invitation link in the next step."

**Solo mode toggle (developer/test):**
- Hidden under an expandable "Advanced" disclosure.
- "Create this as a solo test case (I'll play both parties)" checkbox.

**Submit → Case created, routes to Post-Create screen.**

### 4.6 Post-Create (Invite Sharing) (`/cases/:id/invite`)

**Purpose:** Get the initiator to share the link with the other party.

**Layout:**
- Heading: "Your case is ready. Send this link to Jordan."
- Invite link displayed in a large, copyable field with a "Copy link" primary button.
- Three preset share options:
  - Copy for email (opens mailto: with a pre-written friendly message)
  - Copy for text message (copies a shorter variant)
  - Just copy the link
- Below: "What should I tell them?" — expandable section with suggested language:
  > "Hey Jordan — I found this thing called Clarity. It's a private tool that helps two people work through something difficult together with an AI mediator. I thought it might help us work through the [topic]. Here's a link to join: [link]. No pressure — let me know what you think."
- Secondary: "Or, start your private coaching now →" (they don't have to wait for Jordan to accept before beginning their own private coaching)

### 4.7 Private Coaching (`/cases/:id/private`)

**Purpose:** A confidential conversation with the AI to articulate one's position.

**Layout (full-height, chat-centric):**

```
┌────────────────────────────────────────────────────────────────┐
│ ← Dashboard │ Case with Jordan • Private Coaching              │
├────────────────────────────────────────────────────────────────┤
│  🔒 This conversation is private to you. Jordan will never see │
│     any of it. [Learn more about privacy]                      │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   Coach:  Hi Alex. I'm here to help you think through what's  │
│           going on. Before we get into anything specific, I'd │
│           like to understand how you're feeling about it right │
│           now. Can you describe that?                          │
│                                                                │
│   You:   Honestly, I'm frustrated. I feel like Jordan doesn't │
│          respect my time.                                      │
│                                                                │
│   Coach:  That's helpful context. Can you tell me about a     │
│           recent moment when you felt that way? [streaming...] │
│                                                                │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│ [Textarea: Type your message...]              [Send ↵]        │
├────────────────────────────────────────────────────────────────┤
│ When you've had enough, you can [mark private coaching         │
│ complete] — the joint session starts after you both do.        │
└────────────────────────────────────────────────────────────────┘
```

**Details:**
- Privacy banner is persistent and lockable-looking. The lock icon is not decoration — clicking it opens a modal explaining exactly what's private and why.
- Coach messages rendered in `--accent-subtle` bubbles, left-aligned, with Sparkles icon.
- User messages rendered in `--bg-surface`, right-aligned, no icon.
- The "mark complete" action is a footer CTA, not a big prominent button — we don't want users to rush through private coaching.
- Mark Complete opens a confirmation: "You've had {N} messages with the Coach. Ready to move on to the joint session with Jordan?" with Continue Coaching / Mark Complete buttons.

**Streaming behavior:**
- The AI message appears as a bubble with a blinking cursor.
- Text streams character-by-character.
- Copy button only appears after the message is `COMPLETE`.

**Input states:**
- While AI is responding, input is enabled (user can pre-type the next message) but Send is disabled.
- Shift-enter for newline, enter to send.

### 4.8 Ready for Joint (`/cases/:id/ready`)

**Purpose:** A moment of pause and preparation before the joint session. This screen matters — it's where the product adds unique value.

**Layout:**
```
┌────────────────────────────────────────────────────────────────┐
│ ← Dashboard │ Case with Jordan • Ready for Joint Session       │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   You've both completed private coaching. Here's what the      │
│   Coach has prepared for you before the joint session:         │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐   │
│  │ 🔒 Private to you — Jordan has their own version       │   │
│  │                                                        │   │
│  │ **Areas of likely agreement**                          │   │
│  │ Both of you value the project's success and both       │   │
│  │ recognize that the current timing tension is solvable. │   │
│  │                                                        │   │
│  │ **Points that will need real discussion**              │   │
│  │ There's a genuine difference in how each of you        │   │
│  │ prioritizes scope vs. deadline…                        │   │
│  │                                                        │   │
│  │ **Suggested approach**                                 │   │
│  │ Start by acknowledging what's working before raising   │   │
│  │ the constraint question…                               │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                │
│   Take your time reading this. When you're ready:              │
│                                                                │
│              [Enter Joint Session →]                           │
│                                                                │
│   (Jordan will see you've entered when they enter too.)        │
└────────────────────────────────────────────────────────────────┘
```

**Details:**
- Synthesis text is formatted with markdown (headings, bold).
- The "Enter" button is large and primary — this IS the main action.
- Once a party enters, the case moves to JOINT_ACTIVE; the other party can enter on their own schedule.
- The synthesis remains accessible from a "View my guidance" link in the joint chat top nav.

### 4.9 Joint Chat (`/cases/:id/joint`)

**Purpose:** The shared conversation, facilitated by the Coach. This is the heart of the product.

**Layout (desktop, 3-column):**
```
┌──────────────────────────────────────────────────────────────────────┐
│ ← Back │ Case with Jordan • Joint Session │ [My guidance] [Close]   │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Coach:  Welcome, Alex and Jordan. I'm here to help keep this      │
│           conversation productive. Take it at your own pace.        │
│                                                                      │
│   Jordan: Hey Alex. I want to start by saying I hear you on the     │
│           timing thing…                                              │
│                                                                      │
│   Alex:   Thanks Jordan. I appreciate that. Here's where I'm at... │
│                                                                      │
│   Coach:  ⟡ A point of agreement is starting to emerge: you both   │
│           want the project to succeed and you're both flexible on   │
│           the details. Want to name the specific constraint next?   │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ [Type your message directly, or...] [✨ Draft with Coach]  [Send]   │
└──────────────────────────────────────────────────────────────────────┘
```

**Details:**

**Message authorship visualization:**
- Each participant has a consistent avatar color: Alex = soft blue, Jordan = soft rose, Coach = `--coach-accent` lavender.
- Coach messages have a distinctive left border (`--coach-accent`) and a ⟡ glyph to signal "Coach intervention."
- Timestamps appear on hover.

**Draft Coach entry:**
- Clicking "✨ Draft with Coach" opens the Draft Coach panel (see §4.10).
- Users can also type directly in the input and Send, bypassing Draft Coach entirely. Draft Coach is help, not a gate.

**Real-time indicators:**
- When the other party is typing, a subtle "Jordan is typing..." appears below the input. (Deferred to v1.1 per tech spec, but reserve the visual space in v1.)
- When the Coach is generating, a "Coach is thinking..." inline message.

**Close Case action:**
- "Close" in the top nav opens a modal (see §4.11).

**Mobile layout:**
- Draft Coach becomes a full-screen bottom sheet, not a side panel.
- Top nav collapses to a hamburger.

### 4.10 Draft Coach Panel (modal/side-panel in joint chat)

**Purpose:** Coach a user toward a good message without writing it for them.

**Trigger:** User clicks "Draft with Coach" in the joint chat input bar.

**Layout (desktop — slides in from right, 420px wide, full height):**
```
┌──────────────────────────────────────┐
│ ✨ Draft Coach           🔒  [✕ close]│
├──────────────────────────────────────┤
│  This is private to you. Jordan      │
│  can't see what you're discussing    │
│  here.                               │
├──────────────────────────────────────┤
│                                      │
│  Coach:  What are you trying to say  │
│          next?                       │
│                                      │
│  You:    I want to push back on the  │
│          deadline thing but without  │
│          sounding like I'm blaming   │
│          them.                       │
│                                      │
│  Coach:  Good instinct. What's the   │
│          actual constraint you need  │
│          them to hear?               │
│                                      │
│  You:    [typing...]                 │
│                                      │
├──────────────────────────────────────┤
│ [Textarea]                    [Send] │
│ When you're ready: [Draft it for me]│
└──────────────────────────────────────┘
```

**When the draft is ready:**
```
┌──────────────────────────────────────┐
│ ✨ Draft Coach           🔒  [✕]     │
├──────────────────────────────────────┤
│  Here's a draft based on what we     │
│  talked about:                       │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ "Hey Jordan — I want to be      │  │
│  │ straight with you about the     │  │
│  │ deadline. The constraint isn't  │  │
│  │ ambition, it's that I have a    │  │
│  │ hard commitment on April 30     │  │
│  │ that I can't move. Can we work │  │
│  │ backwards from there together?" │  │
│  └────────────────────────────────┘  │
│                                      │
│  [Send this message] ←  PRIMARY     │
│  [Edit before sending]               │
│  [Keep refining with Coach]          │
│  [Discard]                           │
└──────────────────────────────────────┘
```

**Critical interaction details:**
- The "Send this message" button is the ONLY way the draft reaches the joint chat.
- Clicking Edit drops the draft into the normal joint-chat input, closes the Draft Coach panel, and the user can tweak and send from there.
- Clicking "Keep refining" returns to the coaching conversation; the AI can produce a new draft later.
- Discard closes the panel and marks the `draftSession` as DISCARDED. No message is sent.

**The privacy panel visually:**
- The small lock icon in the header is persistent.
- Hovering it: "Jordan can't see any of this. Only the final message you send goes to the joint chat."

### 4.11 Closure Flow

**Propose closure modal:**
- Triggered by "Close" in joint chat nav.
- Options: "Resolved" / "Not resolved" / "Take a break"
- If "Resolved":
  - Textarea: "Briefly describe what you agreed to." (required, 5 rows)
  - Message: "Jordan will see this summary and confirm. The case won't close until you both agree."
  - [Propose Resolution] [Cancel]
- If "Not resolved":
  - Warning styling.
  - Textarea: "Anything you want Jordan to know? (optional)"
  - Message: "This closes the case immediately for both of you. You can reopen by starting a new case."
  - [Close without resolution] [Cancel]
- If "Take a break":
  - Closes the tab, case stays JOINT_ACTIVE.

**Confirm closure banner (shown to the other party when a closure has been proposed):**
```
┌──────────────────────────────────────────────────────┐
│ 📬 Jordan has proposed resolving this case.         │
│    Their summary: "We agreed to..."                  │
│    [Confirm] [Reject and keep talking]              │
└──────────────────────────────────────────────────────┘
```
- Banner sits above the chat input, below the last message.
- Confirming transitions to CLOSED_RESOLVED and opens the closed-case view.
- Rejecting clears the proposal, optionally with a message to the other party.

### 4.12 Closed Case View (`/cases/:id/closed`)

**Purpose:** Read-only archive.

**Layout:**
- Header with case name, category, closure date, and outcome (Resolved / Not Resolved / Abandoned).
- If Resolved: closure summary prominently displayed.
- Full joint chat transcript (read-only).
- Nav tabs: Joint Chat | My Private Coaching (only accessible to you) | My Guidance
- Banner: "This case is closed. No new messages can be added."

The closed case view never shows the other party's private coaching or their synthesis, ever — even after closure.

### 4.13 Admin Views (P1)

**Admin Templates List (`/admin/templates`):**
- Table: Category | Name | Current Version | Status (Active / Archived) | Pinned Cases Count
- [+ New Template] button
- Click row → edit view

**Template Edit (`/admin/templates/:id`):**
- Two-pane layout:
  - Left: current draft form
    - Category (select)
    - Name (text)
    - Global Guidance (large textarea, markdown)
    - Coach Instructions (textarea, markdown)
    - Draft Coach Instructions (textarea, markdown)
    - Notes (textarea — admin-only changelog)
  - Right: version history timeline
    - Each published version shown with date + admin + notes + "View" button (read-only diff)
- [Publish New Version] button (primary) — creates immutable version
- [Archive Template] button (danger) — confirmation modal

**Audit Log (`/admin/audit`):**
- Filterable table: Actor | Action | Target | Timestamp
- Click row → JSON payload in a drawer
- Not editable.

---

## 5. Component Inventory

### 5.1 Core Components
- `ChatWindow` — base component used by Private Coaching, Joint Chat, Draft Coach
- `MessageBubble` — handles user/coach/system variants
- `StreamingIndicator` — blinking cursor for in-progress AI messages
- `MessageInput` — textarea + send button, with Shift-Enter newline
- `PrivacyBanner` — consistent "this is private" callout
- `PartyAvatar` — colored circle with initial, consistent per party
- `CoachIntervention` — styled coach message with ⟡ glyph
- `PhaseHeader` — top nav showing current case phase
- `StatusPill` — small status indicator for dashboard rows
- `PartyToggle` — solo mode's segmented control

### 5.2 Primitives (shadcn/ui)
- Button (default, primary, secondary, danger, ghost)
- Input, Textarea
- Dialog (modal)
- Sheet (side panel / bottom sheet)
- Tooltip
- Select, RadioGroup
- Card
- Toast (for ephemeral notifications)

---

## 6. Interaction Patterns

### 6.1 Streaming Text
- Character-by-character rendering (not word-by-word — reads less jittery)
- Cursor at the end of streaming text (thin vertical bar, blinks at 500ms)
- Auto-scroll follows streaming unless user has scrolled up (sticky scroll)

### 6.2 Error & Retry
- AI errors render inline as a message bubble with a warning tint and a [Retry] button
- Network errors use a toast, not inline (they're transient)
- Form errors render inline below the input

### 6.3 Loading States
- Use skeleton screens, not spinners, for anything > 300ms
- Dashboard load: skeleton of 3 case rows
- Case detail load: skeleton of the phase-appropriate layout

### 6.4 Empty States
- Friendly copy, never cutesy
- Dashboard empty: "No cases yet. When you're ready to work through something, start a new case."
- Joint chat empty (shouldn't happen — Coach always opens): "Coach is preparing…"
- Admin templates empty: "No templates yet. The app will use a built-in default baseline. Create a template when you want to tune the Coach's behavior per category."

### 6.5 Confirmations
- Destructive or state-changing actions require confirmation modals
- Confirmations describe what will happen: "This will close the case for both of you. Jordan will be notified."
- Never use browser `confirm()` — always a styled modal

### 6.6 Keyboard Shortcuts
- Enter to send (any message input)
- Shift-Enter for newline
- Esc to close any modal or side panel
- Cmd/Ctrl-K to open case search (v1.1)

---

## 7. Accessibility Details

### 7.1 Structural
- Single `<main>` landmark per page
- Chat regions use `role="log"` + `aria-live="polite"`
- New messages are appended; screen readers announce them without disrupting current reading

### 7.2 Focus
- On route change, focus moves to the page's `<h1>`
- On modal open, focus moves to the first focusable element; trapped until close; restored on close
- On Draft Coach panel open, focus moves to the textarea

### 7.3 Visual
- Focus rings use `--accent` with 2px outline + 2px offset
- Never remove focus rings
- Text contrast meets WCAG AA everywhere; verified via Playwright accessibility snapshot

### 7.4 Motion
- Respect `prefers-reduced-motion`: disable streaming cursor animation, route crossfades, and message fade-ins

### 7.5 Screen Reader Copy
- Streaming messages announce "Coach is replying" once, not on every character update
- Privacy banner reads: "Private conversation. Only you and the AI coach see this."
- The "mark complete" CTA reads: "Mark private coaching complete. This moves the case to the joint session with [other party]."

---

## 8. Content & Tone Guidelines

Copy is as much of the design as visuals. A few rules:

- **Never use "arbiter," "judgment," or "verdict."** Use: coach, guidance, synthesis, resolution.
- **Never sound legal.** "What a good outcome would look like" > "desired resolution terms."
- **Use second-person for the user, third-person for the other party.** "You and Jordan" > "the parties."
- **The AI never claims authority.** It "offers," "suggests," "wonders." It doesn't "conclude" or "rule."
- **Privacy copy is plain, not corporate.** "Jordan can't see this" > "This content is restricted from the other party."
- **No exclamation marks from the AI.** The tone is steady, not peppy.
- **Closure copy is understated.** "Case closed." not "🎉 Congratulations on resolving your conflict!"

---

## 9. Edge Cases & Their UI

| Case | UI |
|------|-----|
| Invited party never joins (>7 days) | Initiator sees a "Nudge Jordan" button that re-opens the share screen. After 30 days, case auto-closes as ABANDONED. |
| Other party enters joint chat but goes silent | No special UI in v1. The waiting party sees the chat as-is. |
| AI generates a response rejected by privacy filter twice | Coach posts: "I'm having trouble responding to that right now. Could either of you rephrase?" |
| Cost cap hit mid-conversation | Coach posts a final message explaining; input stays open for direct human exchange without AI |
| User closes tab mid-stream | On reload, the message row reflects final state (complete or error). No weird partial UI. |
| Admin archives a template currently in use | Existing cases continue with their pinned version. Admin sees a warning with a count of pinned cases. |
| Magic link email delayed | Login screen offers "Didn't get it? Try Google instead." |
| Invited party tries to join from a different email than initiator invited | Not checked in v1 (invite is open to whoever has the link; consistent with how most share-link tools work). v1.1 adds optional email-binding. |
| Browser back button in mid-flow | Normal routing; phase is determined by case status, so user can never end up on a phase screen that doesn't match the case state |

---

## 10. Design Artifacts Required Before Build

- [ ] Figma file with all screens in light mode (desktop + mobile breakpoints)
- [ ] Color tokens exported to Tailwind config
- [ ] Icon set selection locked (Lucide subset)
- [ ] Empty-state illustrations — v1 uses no illustrations (text-only empty states); defer illustration pass to post-beta
- [ ] Logo / wordmark for Clarity — simple wordmark in Inter 600, no logomark in v1
- [ ] Favicon + app icons

---

## 11. Open Design Questions

| # | Question | Proposed Default |
|---|----------|------------------|
| D1 | Should the Coach AI have a name or stay "Coach"? | Stay "Coach". A named persona feels like a companion app and overclaims intimacy. |
| D2 | Party color assignment: fixed (initiator = blue) or randomized? | Fixed by role: initiator = blue, invitee = rose, coach = lavender. Consistency over variety. |
| D3 | Should closure have a satisfying visual moment? | No. The design principle is "quiet." A calm confirmation screen, not a celebration. |
| D4 | Dark mode for v1? | Yes — minimal additional effort when tokens are properly used. Ship it. |
| D5 | Should private coaching show message count or time-spent progress? | No. We don't want users to optimize for a metric. Just let them talk until they feel ready. |
| D6 | Visual treatment of the "solo mode" flag — how strong? | Strong. Coach-accent banner, party toggle prominent. Never let a tester confuse their solo case with a real one. |

---

*Clarity · Design Doc v1.0 · Applied Labs · May 2026*

```

## decomposition-plan.md

```
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

```

## STYLE_GUIDE.md

```
# Clarity — Style Guide

**Version:** 1.0 · May 2026
**Audience:** The implementing agent (and any designer or engineer after it). This document is the single source of truth for visual decisions. When it disagrees with code, update this file first, then the code.

---

## 0. How to use this guide

The agent reads this file before touching any UI. The order of authority is:

1. **`docs/style/STYLE_GUIDE.md`** — this file. Decisions, rationale, hard rules.
2. **`docs/style/globals.css`** — runtime source of truth for tokens.
3. **`docs/style/theme.ts`** — programmatic mirror. Use only when JS needs raw values (charts, SVG, email).
4. **`docs/style/components.css`** — reusable class recipes (`.cc-btn-primary`, `.cc-bubble-coach`, …) for patterns that appear in more than one component.
5. **`docs/style/shadcn-overrides.tsx`** — drop-in replacements for shadcn primitives pre-wired to these tokens.
6. **`docs/style/style-guide.html`** — visual reference. Open it to see what "correct" looks like.

If something isn't covered here, ask. Do not invent a new color, radius, or motion curve.

---

## 1. Principles (in priority order)

Five rules. When two conflict, the earlier one wins.

1. **Calm over clever.** The user is in a stressful conversation. The UI must feel like a breath, not a game. No saturated colors, no celebratory motion, no emoji from the product voice.
2. **The human decides.** Every AI output is a suggestion. The Send button is always a human action, never automatic.
3. **Privacy is visible.** When data is private, the screen says so — with a lock icon, a warm tint, and plain-English copy. Trust is earned by showing the seams.
4. **One primary action.** Exactly one sage-filled button per screen. Everything else is secondary or ghost. If you feel the need for two primaries, one of them is wrong.
5. **Presence over polish.** Spend motion on real interaction — streaming cursors, live status, arriving messages. Not on decorative flourish.

---

## 2. Color

### 2.1 Palette philosophy

Warm off-whites and sage greens. No pure black, no pure white in the light theme. Every neutral has a slight amber warmth; every accent is slightly desaturated. Dark mode inverts luminance but preserves warmth.

### 2.2 Token reference

All tokens are declared in `globals.css` as CSS custom properties. Reference them via utility classes (`bg-canvas`, `text-primary`) or CSS vars (`var(--accent)`). Never paste a hex into a component.

#### Neutrals

| Token                    | Light     | Dark      | Use                                                         |
| ------------------------ | --------- | --------- | ----------------------------------------------------------- |
| `--bg-canvas`            | `#FAF8F5` | `#1A1816` | Page background — the "outside" of everything.              |
| `--bg-surface`           | `#FFFFFF` | `#242220` | Cards, bubbles, inputs — the "inside" of things.            |
| `--bg-surface-subtle`    | `#F3EFE9` | `#2E2B28` | Hover states, alt rows, quiet containers.                   |
| `--text-primary`         | `#1F1D1A` | `#F2EFE9` | Default body and heading color.                             |
| `--text-secondary`       | `#5C5952` | `#A8A39A` | Meta, helper text, secondary labels.                        |
| `--text-tertiary`        | `#8A8680` | `#7A766E` | Timestamps, placeholders, very quiet labels.                |
| `--border-default`       | `#E5E0D8` | `#3A3632` | Default 1px borders. Dividers.                              |
| `--border-strong`        | `#CBC4B8` | `#4A4640` | Input borders, stronger dividers.                           |

#### Accent — Sage (primary action)

| Token              | Light     | Dark      | Use                                            |
| ------------------ | --------- | --------- | ---------------------------------------------- |
| `--accent`         | `#6B8E7F` | `#89A99B` | Primary button fill, selected state, focus ring. |
| `--accent-hover`   | `#5A7A6C` | `#9ABAAC` | Primary button hover.                          |
| `--accent-subtle`  | `#DCE7E0` | `#2E3A35` | Coach bubble background, selected card tint.  |
| `--accent-on`      | `#FFFFFF` | `#1A1816` | Text on accent fill (primary button label).    |

#### Coach — Dusty Lavender (AI identity)

Used exclusively for AI Coach touches in the **joint session**, where the coach needs to be visually distinct from either party. In the **private phase**, the Coach uses `--accent-subtle` bubbles because there's no party color to conflict with.

| Token              | Light     | Dark      | Use                                     |
| ------------------ | --------- | --------- | --------------------------------------- |
| `--coach-accent`   | `#8B7AB5` | `#A797CC` | Left border on joint-session bubbles, sparkles icon. |
| `--coach-subtle`   | `#EAE4F2` | `#342E42` | Joint-session Coach bubble background.  |

#### Party colors (joint chat)

| Token                          | Light     | Dark      | Use                                |
| ------------------------------ | --------- | --------- | ---------------------------------- |
| `--party-initiator`            | `#6B85A8` | `#8BA3C2` | Avatar bg for case initiator.      |
| `--party-initiator-subtle`     | `#DFE5EF` | `#2C3542` | Initiator bubble background.       |
| `--party-invitee`              | `#B07A8F` | `#CC96A9` | Avatar bg for invitee.             |
| `--party-invitee-subtle`       | `#EFE0E4` | `#3E2E34` | Invitee bubble background.         |

Assignments are stable per case — whoever created the case is always the initiator color on both screens.

#### Feedback

| Token              | Light     | Dark      | Use                                            |
| ------------------ | --------- | --------- | ---------------------------------------------- |
| `--danger`         | `#B5594D` | `#CC786D` | Destructive button, error border, error text.  |
| `--danger-subtle`  | `#F2DCD8` | `#3E2A27` | Error bubble / banner background.              |
| `--warning`        | `#B58B4D` | `#CC9F6D` | Draft-coach caution, "Ready" status highlight. |
| `--warning-subtle` | `#F2E5D4` | `#3E3228` | Warning banner background.                     |
| `--success`        | `#6B8E7F` | `#89A99B` | Aliased to `--accent`. Resolved-case accents.  |

No pure red. Terracotta is the danger hue — it reads as serious without feeling aggressive.

#### Tints

| Token            | Light     | Dark      | Use                                                                 |
| ---------------- | --------- | --------- | ------------------------------------------------------------------- |
| `--private-tint` | `#F0E9E0` | `#2D2924` | Any private-to-user surface. Synthesis card, Draft Coach, "private" banners. This color does the heavy lifting of **"you can only see this."** |

### 2.3 Contrast

Every foreground/background pair hits WCAG AA (4.5:1 for body, 3:1 for large). Dark mode was checked separately. If you introduce a new combo, re-verify.

---

## 3. Typography

### 3.1 Families

- **Inter** — everything UI.
- **JetBrains Mono** — invite codes, case IDs, any token or machine string.

Load both from Google Fonts at weights 400, 500, 600 (Inter) and 400, 500 (Mono). No variable-font axes beyond weight.

### 3.2 Weights

- **400 Regular** — body, chat, meta, timestamps.
- **500 Medium** — every heading, every label, every button. **Never use 700.** Bold headings feel shouty in a mediation context.
- **600 Semibold** — reserved. Not currently used.

### 3.3 Scale

| Role      | Size | Line | Weight | Tracking  | Use                                                |
| --------- | ---- | ---- | ------ | --------- | -------------------------------------------------- |
| display   | 32   | 40   | 500    | -0.02em   | Onboarding hero, landing page headline.            |
| h1        | 24   | 32   | 500    | -0.015em  | Page titles, case names.                           |
| h2        | 20   | 28   | 500    | -0.01em   | Section headers inside a page.                     |
| h3        | 17   | 24   | 500    | 0         | Synthesis card section, sub-headers.               |
| body      | 15   | 1.6  | 400    | 0         | Default paragraph text.                            |
| chat      | 16   | 1.55 | 400    | 0         | Message bubble text — bumped up for readability.   |
| label     | 14   | 20   | 500    | 0         | Form labels, button text.                          |
| meta      | 13   | 18   | 400    | 0         | Helper text, meta rows, secondary info.            |
| timestamp | 12   | 16   | 400    | 0         | Timestamps, ultra-quiet labels.                    |

`body` and `chat` use unitless line-heights so they scale with user font-size preferences. Everything else uses px lines for deliberate vertical rhythm.

### 3.4 Rendering

Always:

```css
-webkit-font-smoothing: antialiased;
-moz-osx-font-smoothing: grayscale;
text-rendering: optimizeLegibility;
```

Set once on `html` in `globals.css`. Already handled.

---

## 4. Spacing, radius, shadow

### 4.1 Spacing (8-point grid)

Scale: `4, 8, 12, 16, 20, 24, 32, 40, 48, 64`. These map to Tailwind's default `1, 2, 3, 4, 5, 6, 8, 10, 12, 16` — no custom spacing extension needed.

### 4.2 Radius

| Token           | Value | Use                                         |
| --------------- | ----- | ------------------------------------------- |
| `--radius-sm`   | 6px   | Small pills, input corners on dense forms.  |
| `--radius-md`   | 10px  | Buttons, inputs, compact cards.             |
| `--radius-lg`   | 14px  | Bubbles, case rows, panels.                 |
| `--radius-xl`   | 20px  | Modals, large feature cards.                |
| `--radius-full` | 9999  | Pills, avatars, circular buttons.           |

No hard corners. Never use `border-radius: 0` on interactive surfaces.

### 4.3 Shadow

| Token          | Value                           | Use                                    |
| -------------- | ------------------------------- | -------------------------------------- |
| `--shadow-0`   | `none`                          | Default. Most surfaces are flat.       |
| `--shadow-1`   | `0 1px 2px rgba(0,0,0,.04)`     | Cards that need a whisper of lift.     |
| `--shadow-2`   | `0 4px 12px rgba(0,0,0,.06)`    | Popovers, dropdowns, tooltips.         |
| `--shadow-3`   | `0 12px 32px rgba(0,0,0,.10)`   | Modals, side sheets (Draft Coach).     |

Dark mode scales alpha up (`.20 / .28 / .40`) so the elevation is still visible.

---

## 5. Motion

- **Ease:** `cubic-bezier(0.2, 0.7, 0.3, 1)` for everything. Slightly bouncy exit, confident arrival.
- **Duration:** 150ms for hover/state change. 200ms for panels/sheets. 300ms only for first-time reveals.
- **No bounce, no spring, no decorative.** Motion serves the interaction, not the brand.
- **Streaming cursor** is the one exception — a 1s steps(2) blink on AI text as it arrives. This is a feature, not decoration.
- **Respect `prefers-reduced-motion`.** Already wired in `globals.css`.

---

## 6. Components

### 6.1 Buttons

One variant per intent. Size variants exist but should be used sparingly.

| Variant     | When                                              |
| ----------- | ------------------------------------------------- |
| `primary`   | The one action you want the user to take. Sage fill. |
| `secondary` | Alternative actions (Cancel, Back, Edit).         |
| `ghost`     | Tertiary — icon buttons, header nav.              |
| `danger`    | Close case, delete draft, destructive only.       |
| `link`      | In-flow text links.                               |

- Heights: sm 32, md 40, lg 48.
- Icon-only: 36×36, always labelled via `aria-label`.
- Disabled: 50% opacity, `cursor: not-allowed`, pointer-events: none. Never a different fill color.

### 6.2 Inputs & textareas

- Border `--border-strong` default. On focus, border goes `--accent` with a 3px `--accent-subtle` ring.
- Placeholder is `--text-tertiary`. Never use placeholder as a label.
- Error state: `aria-invalid="true"` → border and ring switch to danger.
- Textareas default to `min-height: 96px`, `resize: vertical`.

### 6.3 Radio cards (category picker)

Used for the "What kind of conflict?" step and any small multi-choice question where each option has a description.

- Default: 1px border `--border-default`.
- Selected: **2px** border `--accent`, background `--accent-subtle`, icon color shifts to accent. Padding compensates for the extra pixel so width stays stable.

### 6.4 Chat bubbles

This is the most-reused component. Six flavors, each with a semantic meaning.

| Bubble class                 | Background          | Border                           | When                                            |
| ---------------------------- | ------------------- | -------------------------------- | ----------------------------------------------- |
| `.cc-bubble`                 | `--bg-surface`      | `1px var(--border-default)`      | User's own messages (private + joint).          |
| `.cc-bubble-coach`           | `--accent-subtle`   | none                             | Coach messages in **private** phase.            |
| `.cc-bubble-coach-joint`     | `--coach-subtle`    | `3px left var(--coach-accent)`   | Coach in **joint** chat (standard).             |
| `.cc-bubble-coach-intervention` | `--coach-subtle` | `4px left var(--coach-accent)`   | Coach mid-argument intervention (heavier left).  |
| `.cc-bubble-party-initiator` | `--party-initiator-subtle` | none                   | Initiator's own messages in joint chat.         |
| `.cc-bubble-party-invitee`   | `--party-invitee-subtle`   | none                   | Invitee's messages in joint chat.               |
| `.cc-bubble-error`           | `--danger-subtle`   | `1px var(--danger)`              | Error state (Coach unavailable, retry prompt).  |

Every bubble:
- `padding: 12px 16px`
- `border-radius: var(--radius-lg)` (14px)
- `max-width: min(640px, 80%)`
- Font: chat (16/1.55)
- Enter animation: 150ms fade + 8px y translate. Once. Do not repeat on scroll.

**Streaming cursor:** a 2px × 1em `currentColor` bar, `animation: cc-blink 1s steps(2, start) infinite`. Placed inline at end of text as it streams. Remove when streaming completes.

### 6.5 Avatars

- Default: 32×32, `border-radius: full`, white initials on a party color.
- Sizes: sm 24, md 32, lg 40. No larger — Clarity has no profile page.
- Colors: `avatar-initiator`, `avatar-invitee`, `avatar-coach`, `avatar-you`. The "you" avatar uses the sage accent — it's the one place the user sees themselves as the primary action color.
- Coach avatar can use a glyph (`⟡`) instead of a letter in joint sessions where the C would read as confusing.

### 6.6 Privacy banner

Every private surface has a banner at the top. Exactly one per phase.

```html
<div class="cc-banner-privacy">
  <svg><!-- lucide lock --></svg>
  <div>
    <strong>Private to you.</strong> Jordan will never see any of it.
    <a href="/privacy">Learn more</a>
  </div>
</div>
```

- Background: `--private-tint` (warm beige/dark amber). Same color everywhere privacy matters — this is the **visual shorthand for "you can only see this."**
- Lock icon is `lucide-react` `Lock` at 16×16, `--text-secondary`.
- Warning variant: switch the icon to `ShieldAlert` and the bg to `--warning-subtle`. Used for draft-warning states only.

### 6.7 Status pills

| Pill           | Color               | When                                           |
| -------------- | ------------------- | ---------------------------------------------- |
| `pill-turn`    | accent on accent-subtle | User's turn to act.                        |
| `pill-waiting` | secondary, outlined dot | Waiting on the other party.                |
| `pill-ready`   | warning              | Joint session ready to enter (soft nudge).    |
| `pill-closed`  | tertiary, square dot | Resolved / archived.                           |

Pill dot shape encodes state: filled circle = active, hollow circle = waiting, square = closed.

### 6.8 Synthesis card

The pre-joint-session moment. It exists to make the user pause before opening the joint chat.

- Background: `--private-tint`. Padded 32px. Radius 14. One per party, never shared.
- Three fixed H3 sections in order: **Areas of likely agreement**, **Points that will need real discussion**, **Suggested approach**. Generated in Coach's own words, never quoting the other party.
- Always paired with the private banner above it (borders joined, no gap).
- CTA at the bottom: single primary button, "Enter joint session →".

### 6.9 Draft Coach panel

Right-side sheet, 420px wide on desktop, bottom sheet on mobile.

- Header: sparkles icon (`--coach-accent`), "Draft Coach" title, lock icon (visual confirmation it's private), close button.
- Private banner directly under header.
- Body: private coaching conversation — uses the same chat bubbles at 14px instead of 16px (narrower surface).
- When Coach produces a final draft, it appears in a `.cc-draft-ready` card — subtle background, quoted text. Followed by a vertical stack of actions: **Send this message** (primary), **Edit before sending** (secondary), **Keep refining with Coach** (ghost), **Discard** (ghost, danger text).
- The user is always the one who sends. Never auto-post.

### 6.10 Solo-mode party toggle

Distinctive by design. Tester should never confuse solo mode with a real conversation.

- Lavender (Coach-colored) border and subtle background — says "this is an AI-adjacent meta control."
- Left label: "VIEWING AS" in uppercase 11px.
- Two segmented buttons: initiator name and invitee name. Active button gets a subtle surface lift and primary text color.
- Position: top-right of the phase header in solo cases.

### 6.11 Case row (dashboard)

- Grid: avatar 40, content 1fr, action auto.
- Padding 20/24. Radius 14. Hover: background `--bg-surface-subtle`.
- Content stack: `Title (16/500)` → `Category · date (meta)` → `Status pill` → `Last activity (timestamp)`.
- Closed cases: `opacity: 0.75` and grayscale avatar.

### 6.12 Modal / Dialog

- Max width 480. Padding 24. Radius 20 (intentionally softer than cards — modals feel like pillows, not cards).
- Shadow 3. Overlay: `rgba(0,0,0,.3)` + 2px backdrop blur.
- Title 20/500, description `--text-secondary` 15/1.6. Actions bottom-right, primary rightmost.
- Animation: 150ms fade + 95%→100% scale on enter. Reverse on exit.

### 6.13 Phase header

Top strip on every in-case screen. Left: back arrow + "Dashboard" link. Center: `Case name · Phase name`. Right: phase-specific actions.

- Height 56 (12px vertical padding + 32px content).
- Background `--bg-surface`, 1px bottom border.
- "Dashboard" link is `--text-secondary`, hover to primary. Separator is `·` in tertiary.

---

## 7. Icons

Library: `lucide-react`.

Install:

```bash
npm i lucide-react
```

| Role                     | Icon                | Size | Color                |
| ------------------------ | ------------------- | ---- | -------------------- |
| Private / locked         | `Lock`              | 16   | `--text-secondary`   |
| AI / Coach               | `Sparkles`          | 16   | `--coach-accent`     |
| Draft warning            | `ShieldAlert`       | 16   | `--warning`          |
| Coach-verified           | `ShieldCheck`       | 16   | `--accent`           |
| Send message             | `Send`              | 16   | inherits from button |
| Close / dismiss          | `X`                 | 16   | inherits             |
| Back nav                 | `ArrowLeft`         | 14   | `--text-secondary`   |
| Forward / enter          | `ArrowRight`        | 14/16| inherits             |
| Category: workplace      | `Briefcase`         | 20   | inherits from card   |
| Category: family         | `Home`              | 20   | inherits             |
| Category: personal       | `Users`             | 20   | inherits             |
| Category: contractual    | `FileText`          | 20   | inherits             |
| Shared visibility        | `Users`             | 16   | `--text-secondary`   |
| Edit draft               | `Pencil`            | 16   | inherits             |
| Regenerate / refine      | `RefreshCw`         | 16   | inherits             |
| Copy                     | `Copy`              | 16   | inherits             |
| Error / alert            | `AlertTriangle`     | 16   | `--danger`           |
| Guidance reference       | `BookOpen`          | 14   | inherits             |
| Discard draft            | `Trash2`            | 16   | `--danger`           |

Always give icons `width` and `height` props (stroke scales with size). Default stroke width 2.

---

## 8. Copy voice

### Never use

- "arbiter", "verdict", "judgment" — legal framing
- "the parties" — impersonal. Use the actual names.
- 🎉 or exclamation marks from the product voice
- "Get started free", pricing language
- "Congratulations on resolving your conflict!"

### Use instead

- "coach", "guidance", "synthesis", "resolution"
- "You and Jordan" (or real names)
- Steady, curious tone. The AI offers, suggests, wonders. It does not assert.
- Plain descriptions. "Case closed." over "Amazing — you did it!"

### Coach voice

Calm, curious, specific. The Coach is a seasoned mediator, not a cheerleader. If a line could appear in a birthday card, rewrite it.

---

## 9. Accessibility checklist

- [ ] All interactive surfaces reachable by keyboard.
- [ ] Focus ring visible (`:focus-visible` is wired in `globals.css`).
- [ ] Every icon either labelled or decorative (`aria-hidden` + label elsewhere).
- [ ] Color never the sole carrier of meaning (status pills pair color + shape + text).
- [ ] `prefers-reduced-motion` respected. Streaming cursor stops animating under reduced motion.
- [ ] WCAG AA contrast in both themes.

---

## 10. File map

```
docs/style/
├─ STYLE_GUIDE.md          ← this doc — decisions & rationale
├─ globals.css             ← runtime tokens, @theme, base layer
├─ components.css          ← reusable class recipes
├─ theme.ts                ← TypeScript mirror, for JS-driven visuals
├─ tailwind.config.ts      ← v4 shim for tooling
├─ shadcn-overrides.tsx    ← drop-in shadcn primitives
└─ style-guide.html        ← visual reference — open to see "correct"
```

### How to wire this into the app

1. Copy `globals.css` and `components.css` into `src/styles/`.
2. Import from your entry: `import "./styles/globals.css";` (components.css is pulled in by globals).
3. Copy `theme.ts` into `src/styles/theme.ts` for typed token access.
4. Copy the bits you want from `shadcn-overrides.tsx` into `src/components/ui/` and delete the stock shadcn versions.
5. Set initial theme on the root: `<html data-theme="light">`. Toggle with a small inline script that reads `localStorage` + `prefers-color-scheme` before paint.

### When you add a new component

1. Check if the pattern exists in `components.css`. If yes, use it.
2. If it's truly new, propose it here first (add a section to §6). Then add the class recipe.
3. Never introduce a one-off color, radius, or shadow. If you need a value that isn't in §2/§4, the token system is missing something — raise it.

---

*End of style guide. Questions? The answer is probably "match `style-guide.html`."*

```

## style-guide.html

```
<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Clarity · Style Guide</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<script src="https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js"></script>
<style>
/* ─── Tweakable tokens (defaults match design doc) ─── */
:root {
  --bg-canvas:#FAF8F5; --bg-surface:#FFFFFF; --bg-surface-subtle:#F3EFE9;
  --text-primary:#1F1D1A; --text-secondary:#5C5952; --text-tertiary:#8A8680;
  --border-default:#E5E0D8; --border-strong:#CBC4B8;
  --accent:#6B8E7F; --accent-hover:#5A7A6C; --accent-subtle:#DCE7E0; --accent-on:#FFFFFF;
  --coach-accent:#8B7AB5; --coach-subtle:#EAE4F2;
  --party-initiator:#6B85A8; --party-initiator-subtle:#DFE5EF;
  --party-invitee:#B07A8F; --party-invitee-subtle:#EFE0E4;
  --danger:#B5594D; --danger-subtle:#F2DCD8;
  --warning:#B58B4D; --warning-subtle:#F2E5D4;
  --private-tint:#F0E9E0;
  --radius-sm:6px; --radius-md:10px; --radius-lg:14px; --radius-xl:20px; --radius-full:9999px;
  --shadow-0:none; --shadow-1:0 1px 2px rgba(0,0,0,.04); --shadow-2:0 4px 12px rgba(0,0,0,.06); --shadow-3:0 12px 32px rgba(0,0,0,.10);
  --ease-out:cubic-bezier(.2,.7,.3,1); --dur-fast:150ms; --dur-medium:200ms;
  --font-sans:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
[data-theme="dark"] {
  --bg-canvas:#1A1816; --bg-surface:#242220; --bg-surface-subtle:#2E2B28;
  --text-primary:#F2EFE9; --text-secondary:#A8A39A; --text-tertiary:#7A766E;
  --border-default:#3A3632; --border-strong:#4A4640;
  --accent:#89A99B; --accent-hover:#9ABAAC; --accent-subtle:#2E3A35; --accent-on:#1A1816;
  --coach-accent:#A797CC; --coach-subtle:#342E42;
  --party-initiator:#8BA3C2; --party-initiator-subtle:#2C3542;
  --party-invitee:#CC96A9; --party-invitee-subtle:#3E2E34;
  --danger:#CC786D; --danger-subtle:#3E2A27;
  --warning:#CC9F6D; --warning-subtle:#3E3228;
  --private-tint:#2D2924;
  --shadow-1:0 1px 2px rgba(0,0,0,.20); --shadow-2:0 4px 12px rgba(0,0,0,.28); --shadow-3:0 12px 32px rgba(0,0,0,.40);
}

/* Variation: "Slate Neutral" — cooler grays, teal accent */
[data-variant="slate"] {
  --bg-canvas:#F7F7F5; --bg-surface:#FFFFFF; --bg-surface-subtle:#EEEEEA;
  --text-primary:#1C1E1F; --text-secondary:#55595C; --text-tertiary:#898D8F;
  --border-default:#E2E3E0; --border-strong:#C7C9C6;
  --accent:#5A8F8A; --accent-hover:#4A7F7A; --accent-subtle:#D9E7E5; --accent-on:#FFFFFF;
  --coach-accent:#7A78B5; --coach-subtle:#E4E3F2;
  --private-tint:#ECECE8;
}
[data-theme="dark"][data-variant="slate"] {
  --bg-canvas:#17191A; --bg-surface:#202223; --bg-surface-subtle:#2B2D2E;
  --text-primary:#EEEFEE; --text-secondary:#A5A8A9; --text-tertiary:#77797A;
  --border-default:#363839; --border-strong:#464849;
  --accent:#7AABA6; --accent-hover:#8BBCB7; --accent-subtle:#2A3A38;
  --coach-accent:#9997CC; --coach-subtle:#302E42;
  --private-tint:#2A2B2C;
}

/* Variation: "Deeper Earth" — richer warmth, terracotta accent */
[data-variant="earth"] {
  --bg-canvas:#F6F1E9; --bg-surface:#FFFBF3; --bg-surface-subtle:#ECE4D3;
  --text-primary:#231D15; --text-secondary:#665A48; --text-tertiary:#928771;
  --border-default:#E0D5BD; --border-strong:#BFB193;
  --accent:#A8624A; --accent-hover:#92533E; --accent-subtle:#F0D9CF; --accent-on:#FFFBF3;
  --coach-accent:#7A6A9E; --coach-subtle:#E8E1F0;
  --private-tint:#F0E4D0;
}
[data-theme="dark"][data-variant="earth"] {
  --bg-canvas:#1E1812; --bg-surface:#28211A; --bg-surface-subtle:#322A22;
  --text-primary:#F0E8D8; --text-secondary:#AFA38C; --text-tertiary:#7E7563;
  --border-default:#403728; --border-strong:#554832;
  --accent:#CC8671; --accent-hover:#D79A87; --accent-subtle:#40291F; --accent-on:#1E1812;
  --coach-accent:#B09EC2; --coach-subtle:#352E42;
  --private-tint:#2E251D;
}

/* ─── Base ─── */
* { box-sizing: border-box; }
html, body { margin:0; padding:0; }
body {
  background: var(--bg-canvas);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 15px; line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  transition: background-color var(--dur-medium) var(--ease-out), color var(--dur-medium) var(--ease-out);
}
h1,h2,h3,h4 { font-weight: 500; margin: 0; letter-spacing: -0.01em; }
code, .mono { font-family: var(--font-mono); }
a { color: var(--accent); text-underline-offset: 2px; }
hr { border: 0; border-top: 1px solid var(--border-default); margin: 0; }

/* layout */
.page { max-width: 1200px; margin: 0 auto; padding: 64px 32px 120px; }
.masthead {
  display:flex; align-items:flex-end; justify-content:space-between; gap:24px;
  padding-bottom: 32px; border-bottom: 1px solid var(--border-default); margin-bottom: 56px;
}
.masthead h1 { font-size: 40px; line-height: 48px; letter-spacing: -0.02em; }
.masthead .subtitle { color: var(--text-secondary); margin-top: 8px; font-size: 15px; }
.masthead .mono-tag { font-family: var(--font-mono); font-size: 12px; color: var(--text-tertiary); margin-top: 12px; }

section { margin-bottom: 72px; }
section > .section-head { margin-bottom: 24px; }
section > .section-head .kicker {
  font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--text-tertiary); margin-bottom: 8px;
}
section > .section-head h2 { font-size: 28px; line-height: 36px; letter-spacing: -0.015em; }
section > .section-head p { color: var(--text-secondary); margin: 8px 0 0; max-width: 640px; }

.grid { display: grid; gap: 16px; }
.grid-2 { grid-template-columns: repeat(2, 1fr); }
.grid-3 { grid-template-columns: repeat(3, 1fr); }
.grid-4 { grid-template-columns: repeat(4, 1fr); }
.grid-auto { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }

/* swatch */
.swatch {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.swatch-chip { height: 88px; border-bottom: 1px solid var(--border-default); }
.swatch-body { padding: 12px 14px; }
.swatch-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
.swatch-token { font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary); margin-top: 2px; }
.swatch-hex { font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); margin-top: 2px; }

/* type spec */
.type-row {
  display: grid; grid-template-columns: 180px 1fr 240px; gap: 24px;
  padding: 20px 0; border-bottom: 1px solid var(--border-default); align-items: baseline;
}
.type-row:last-child { border-bottom: 0; }
.type-label { font-family: var(--font-mono); font-size: 12px; color: var(--text-tertiary); }
.type-spec { font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); }

/* scale demos */
.scale-row {
  display: grid; grid-template-columns: 60px 1fr; gap: 16px; align-items: center; padding: 10px 0;
}
.scale-row .mono { font-size: 11px; color: var(--text-tertiary); }
.scale-block { background: var(--accent-subtle); border-radius: var(--radius-sm); height: 40px; }
.radius-block {
  background: var(--accent-subtle); border: 1px solid var(--accent); width: 120px; height: 80px;
}

.shadow-block {
  background: var(--bg-surface); border: 1px solid var(--border-default);
  width: 100%; height: 120px; border-radius: var(--radius-lg); display:flex; align-items:center; justify-content:center;
  color: var(--text-secondary); font-family: var(--font-mono); font-size: 12px;
}

/* buttons */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  padding: 10px 16px; border-radius: var(--radius-md);
  font-family: var(--font-sans); font-size: 14px; font-weight: 500; line-height: 20px;
  border: 1px solid transparent; cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.btn-primary { background: var(--accent); color: var(--accent-on); border-color: var(--accent); }
.btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn-secondary { background: var(--bg-surface); color: var(--text-primary); border-color: var(--border-strong); }
.btn-secondary:hover { background: var(--bg-surface-subtle); }
.btn-ghost { background: transparent; color: var(--text-primary); border-color: transparent; }
.btn-ghost:hover { background: var(--bg-surface-subtle); }
.btn-danger { background: var(--danger); color:#fff; border-color: var(--danger); }
.btn-sm { padding: 6px 12px; font-size: 13px; border-radius: var(--radius-sm); }
.btn-lg { padding: 14px 24px; font-size: 15px; }
.btn[disabled] { opacity: .5; cursor: not-allowed; }
.btn-icon { padding: 8px; width: 36px; height: 36px; }

/* forms */
.input, .textarea {
  width: 100%; padding: 10px 14px;
  background: var(--bg-surface); color: var(--text-primary);
  border: 1px solid var(--border-strong); border-radius: var(--radius-md);
  font-family: var(--font-sans); font-size: 15px; line-height: 1.5;
}
.input::placeholder, .textarea::placeholder { color: var(--text-tertiary); }
.input:focus, .textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-subtle); }
.textarea { min-height: 88px; resize: vertical; }
.label { display:block; font-size: 14px; font-weight: 500; margin-bottom: 6px; }
.helper { display:block; font-size: 13px; color: var(--text-secondary); margin-top: 6px; line-height: 1.5; }
.error { display:block; font-size: 13px; color: var(--danger); margin-top: 6px; }

.radio-card {
  display:flex; align-items:flex-start; gap: 12px;
  padding: 16px; background: var(--bg-surface);
  border: 1px solid var(--border-default); border-radius: var(--radius-md); cursor: pointer;
}
.radio-card[data-selected="true"] {
  border: 2px solid var(--accent); background: var(--accent-subtle); padding: 15px;
}
.radio-card .icon { color: var(--text-secondary); }
.radio-card[data-selected="true"] .icon { color: var(--accent); }
.radio-card .title { font-weight: 500; }
.radio-card .desc { font-size: 13px; color: var(--text-secondary); margin-top: 2px; }

.select {
  appearance: none; width: 100%; padding: 10px 14px;
  background: var(--bg-surface) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238A8680' stroke-width='2'><path d='M6 9l6 6 6-6'/></svg>") no-repeat right 14px center;
  color: var(--text-primary);
  border: 1px solid var(--border-strong); border-radius: var(--radius-md);
  font-family: var(--font-sans); font-size: 15px;
}

/* chat */
.chat-frame {
  background: var(--bg-canvas); border: 1px solid var(--border-default);
  border-radius: var(--radius-lg); overflow: hidden;
}
.chat-body { padding: 20px 24px; }
.chat-row { display: flex; gap: 12px; margin-bottom: 16px; }
.chat-row-right { flex-direction: row-reverse; }
.chat-stack { display: flex; flex-direction: column; gap: 4px; max-width: 70%; }
.chat-row-right .chat-stack { align-items: flex-end; }
.chat-author { font-size: 12px; font-weight: 500; color: var(--text-secondary); padding: 0 4px; }
.chat-timestamp { font-size: 11px; color: var(--text-tertiary); padding: 0 4px; }

.bubble {
  display: inline-block; padding: 12px 16px;
  border-radius: var(--radius-lg); font-size: 16px; line-height: 1.55;
  color: var(--text-primary); background: var(--bg-surface);
  border: 1px solid var(--border-default);
}
.bubble-coach { background: var(--accent-subtle); border-color: transparent; }
.bubble-coach-joint { background: var(--coach-subtle); border: 0; border-left: 3px solid var(--coach-accent); border-top-left-radius: 4px; }
.bubble-coach-intervention { background: var(--coach-subtle); border: 0; border-left: 4px solid var(--coach-accent); border-top-left-radius: 4px; padding-left: 14px; }
.bubble-party-initiator { background: var(--party-initiator-subtle); border-color: transparent; }
.bubble-party-invitee { background: var(--party-invitee-subtle); border-color: transparent; }
.bubble-error { background: var(--danger-subtle); border: 1px solid var(--danger); color: var(--text-primary); display:flex; align-items:center; gap: 10px; }

.cursor {
  display: inline-block; width: 2px; height: 1em; vertical-align: text-bottom;
  background: currentColor; margin-left: 2px;
  animation: blink 1s steps(2,start) infinite;
}
@keyframes blink { to { visibility: hidden; } }

/* avatar */
.avatar {
  flex-shrink: 0; width: 32px; height: 32px; border-radius: var(--radius-full);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 500; color: #fff; background: var(--text-secondary);
}
.avatar-initiator { background: var(--party-initiator); }
.avatar-invitee { background: var(--party-invitee); }
.avatar-coach { background: var(--coach-accent); }
.avatar-you { background: var(--accent); color: var(--accent-on); }

/* banner */
.banner-privacy {
  display: flex; align-items: flex-start; gap: 10px; padding: 12px 16px;
  background: var(--private-tint); border-bottom: 1px solid var(--border-default);
  color: var(--text-secondary); font-size: 13px; line-height: 1.5;
}
.banner-privacy strong { color: var(--text-primary); font-weight: 500; }
.banner-privacy .icon { flex-shrink: 0; margin-top: 1px; color: var(--text-secondary); }

/* pills */
.pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: var(--radius-full);
  font-size: 12px; font-weight: 500;
  background: var(--bg-surface-subtle); color: var(--text-secondary);
}
.pill-dot { width: 8px; height: 8px; border-radius: var(--radius-full); background: currentColor; }
.pill-turn { color: var(--accent); background: var(--accent-subtle); }
.pill-waiting .pill-dot { background: transparent; border: 1.5px solid currentColor; }
.pill-ready { color: var(--warning); background: var(--warning-subtle); }
.pill-closed { color: var(--text-tertiary); }
.pill-closed .pill-dot { border-radius: 2px; }

/* case row */
.case-row {
  display: grid; grid-template-columns: auto 1fr auto;
  gap: 16px; align-items: center;
  padding: 20px 24px; background: var(--bg-surface);
  border: 1px solid var(--border-default); border-radius: var(--radius-lg);
  cursor: pointer; transition: background var(--dur-fast) var(--ease-out);
}
.case-row:hover { background: var(--bg-surface-subtle); }
.case-row .title { font-weight: 500; font-size: 16px; }
.case-row .meta { font-size: 13px; color: var(--text-secondary); margin-top: 2px; }
.case-row .status { font-size: 13px; color: var(--text-secondary); margin-top: 8px; display: inline-flex; align-items: center; gap: 6px; }
.case-row .last { font-size: 12px; color: var(--text-tertiary); margin-top: 8px; }

/* synthesis card */
.synthesis {
  background: var(--private-tint); border: 1px solid var(--border-default);
  border-radius: var(--radius-lg); padding: 32px;
}
.synthesis h3 { font-size: 15px; font-weight: 500; margin: 0 0 8px; color: var(--text-primary); }
.synthesis h3:not(:first-of-type) { margin-top: 24px; }
.synthesis p { margin: 0; line-height: 1.7; }

/* drawer */
.drawer {
  background: var(--bg-surface); border: 1px solid var(--border-default);
  border-radius: var(--radius-xl); box-shadow: var(--shadow-3);
  width: 420px; display: flex; flex-direction: column; overflow: hidden;
}
.drawer-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px; border-bottom: 1px solid var(--border-default);
}
.drawer-header-title { display:flex; align-items:center; gap: 8px; font-weight: 500; }
.drawer-body { padding: 20px; background: var(--bg-canvas); }
.drawer-footer { padding: 16px 20px; border-top: 1px solid var(--border-default); background: var(--bg-surface); }
.draft-ready {
  background: var(--bg-surface-subtle); border: 1px solid var(--border-default);
  border-radius: var(--radius-md); padding: 16px; font-size: 15px; line-height: 1.6; margin-bottom: 16px;
}

/* party toggle */
.party-toggle {
  display: inline-flex; align-items: center; padding: 3px;
  background: var(--coach-subtle); border: 1px solid var(--coach-accent); border-radius: var(--radius-md);
}
.party-toggle-label {
  font-size: 11px; font-weight: 500; color: var(--coach-accent);
  padding: 0 8px; text-transform: uppercase; letter-spacing: 0.05em;
}
.party-toggle-btn {
  padding: 6px 12px; font-size: 13px; font-weight: 500;
  color: var(--text-secondary); background: transparent; border: 0;
  border-radius: var(--radius-sm); cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.party-toggle-btn[data-active="true"] {
  background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--shadow-1);
}

/* phase header */
.phase-header {
  display: flex; align-items: center; gap: 16px;
  padding: 14px 24px; background: var(--bg-surface);
  border-bottom: 1px solid var(--border-default);
}
.phase-header-back { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 13px; text-decoration: none; }
.phase-header-title { font-size: 15px; font-weight: 500; display: flex; align-items: center; gap: 10px; }
.phase-header-sep { color: var(--text-tertiary); }
.phase-header-phase { color: var(--text-secondary); font-weight: 400; }

/* misc layout helpers */
.row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.stack { display: flex; flex-direction: column; gap: 12px; }
.muted { color: var(--text-secondary); }
.tertiary { color: var(--text-tertiary); }

/* tweaks panel */
.tweaks {
  position: fixed; bottom: 16px; right: 16px; z-index: 50;
  background: var(--bg-surface); border: 1px solid var(--border-default);
  border-radius: var(--radius-lg); box-shadow: var(--shadow-3);
  width: 280px; padding: 16px; display: none;
  font-family: var(--font-sans);
}
.tweaks.open { display: block; }
.tweaks h3 { font-size: 13px; margin-bottom: 12px; font-family: var(--font-mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-tertiary); }
.tweaks-field { margin-bottom: 14px; }
.tweaks label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 6px; color: var(--text-secondary); }
.tweaks .segmented {
  display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  background: var(--bg-surface-subtle); border-radius: var(--radius-sm); padding: 2px;
}
.tweaks .segmented button {
  padding: 6px 8px; font-size: 12px; font-weight: 500;
  background: transparent; border: 0; color: var(--text-secondary);
  border-radius: var(--radius-sm); cursor: pointer;
}
.tweaks .segmented button[data-active="true"] {
  background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--shadow-1);
}

/* dual-mode frame — render a component in both light and dark */
.dual {
  display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
}
.dual-pane {
  border-radius: var(--radius-lg); overflow: hidden;
  border: 1px solid var(--border-default);
}
.dual-pane > .pane-body { padding: 24px; }
.dual-label {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary);
  text-transform: uppercase; letter-spacing: 0.08em; padding: 8px 16px;
  border-bottom: 1px solid var(--border-default);
}

/* Inline light/dark isolated scopes for the dual demo */
.scope-light { color-scheme: light; background: #FAF8F5; color: #1F1D1A; }
.scope-dark  { color-scheme: dark;  background: #1A1816; color: #F2EFE9; }

.scope-light {
  --bg-canvas:#FAF8F5; --bg-surface:#FFFFFF; --bg-surface-subtle:#F3EFE9;
  --text-primary:#1F1D1A; --text-secondary:#5C5952; --text-tertiary:#8A8680;
  --border-default:#E5E0D8; --border-strong:#CBC4B8;
  --accent:#6B8E7F; --accent-hover:#5A7A6C; --accent-subtle:#DCE7E0; --accent-on:#FFFFFF;
  --coach-accent:#8B7AB5; --coach-subtle:#EAE4F2;
  --party-initiator:#6B85A8; --party-initiator-subtle:#DFE5EF;
  --party-invitee:#B07A8F; --party-invitee-subtle:#EFE0E4;
  --danger:#B5594D; --danger-subtle:#F2DCD8;
  --warning:#B58B4D; --warning-subtle:#F2E5D4;
  --private-tint:#F0E9E0;
}
.scope-dark {
  --bg-canvas:#1A1816; --bg-surface:#242220; --bg-surface-subtle:#2E2B28;
  --text-primary:#F2EFE9; --text-secondary:#A8A39A; --text-tertiary:#7A766E;
  --border-default:#3A3632; --border-strong:#4A4640;
  --accent:#89A99B; --accent-hover:#9ABAAC; --accent-subtle:#2E3A35; --accent-on:#1A1816;
  --coach-accent:#A797CC; --coach-subtle:#342E42;
  --party-initiator:#8BA3C2; --party-initiator-subtle:#2C3542;
  --party-invitee:#CC96A9; --party-invitee-subtle:#3E2E34;
  --danger:#CC786D; --danger-subtle:#3E2A27;
  --warning:#CC9F6D; --warning-subtle:#3E3228;
  --private-tint:#2D2924;
}

[data-variant="slate"] .scope-light {
  --bg-canvas:#F7F7F5; --bg-surface:#FFFFFF; --bg-surface-subtle:#EEEEEA;
  --text-primary:#1C1E1F; --text-secondary:#55595C; --text-tertiary:#898D8F;
  --border-default:#E2E3E0; --border-strong:#C7C9C6;
  --accent:#5A8F8A; --accent-hover:#4A7F7A; --accent-subtle:#D9E7E5;
  --coach-accent:#7A78B5; --coach-subtle:#E4E3F2; --private-tint:#ECECE8;
  background:#F7F7F5; color:#1C1E1F;
}
[data-variant="slate"] .scope-dark {
  --bg-canvas:#17191A; --bg-surface:#202223; --bg-surface-subtle:#2B2D2E;
  --text-primary:#EEEFEE; --text-secondary:#A5A8A9; --text-tertiary:#77797A;
  --border-default:#363839; --border-strong:#464849;
  --accent:#7AABA6; --accent-hover:#8BBCB7; --accent-subtle:#2A3A38;
  --coach-accent:#9997CC; --coach-subtle:#302E42; --private-tint:#2A2B2C;
  background:#17191A; color:#EEEFEE;
}
[data-variant="earth"] .scope-light {
  --bg-canvas:#F6F1E9; --bg-surface:#FFFBF3; --bg-surface-subtle:#ECE4D3;
  --text-primary:#231D15; --text-secondary:#665A48; --text-tertiary:#928771;
  --border-default:#E0D5BD; --border-strong:#BFB193;
  --accent:#A8624A; --accent-hover:#92533E; --accent-subtle:#F0D9CF; --accent-on:#FFFBF3;
  --coach-accent:#7A6A9E; --coach-subtle:#E8E1F0; --private-tint:#F0E4D0;
  background:#F6F1E9; color:#231D15;
}
[data-variant="earth"] .scope-dark {
  --bg-canvas:#1E1812; --bg-surface:#28211A; --bg-surface-subtle:#322A22;
  --text-primary:#F0E8D8; --text-secondary:#AFA38C; --text-tertiary:#7E7563;
  --border-default:#403728; --border-strong:#554832;
  --accent:#CC8671; --accent-hover:#D79A87; --accent-subtle:#40291F; --accent-on:#1E1812;
  --coach-accent:#B09EC2; --coach-subtle:#352E42; --private-tint:#2E251D;
  background:#1E1812; color:#F0E8D8;
}

/* Toolbar */
.toolbar {
  position: sticky; top: 0; z-index: 40;
  background: color-mix(in oklch, var(--bg-canvas) 92%, transparent);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border-default);
}
.toolbar-inner {
  max-width: 1200px; margin: 0 auto; padding: 12px 32px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
}
.toolbar-brand { display: flex; align-items: center; gap: 10px; font-weight: 500; }
.toolbar-brand .logo-dot { width: 14px; height: 14px; border-radius: 4px; background: var(--accent); }
.toolbar-actions { display: flex; gap: 8px; align-items: center; }

/* anchors / TOC */
.toc {
  display: flex; flex-wrap: wrap; gap: 8px 14px;
  padding: 16px 20px; background: var(--bg-surface);
  border: 1px solid var(--border-default); border-radius: var(--radius-lg);
  font-size: 13px; color: var(--text-secondary);
  margin-bottom: 56px;
}
.toc a { color: var(--text-secondary); text-decoration: none; padding: 4px 8px; border-radius: var(--radius-sm); }
.toc a:hover { background: var(--bg-surface-subtle); color: var(--text-primary); }

[data-tweaks-on="false"] .tweaks { display: none; }
</style>
</head>
<body>

<!-- ─── Toolbar ─────────────────────────────────────────────── -->
<div class="toolbar">
  <div class="toolbar-inner">
    <div class="toolbar-brand">
      <span class="logo-dot"></span>
      <span>Clarity · Style Guide</span>
      <span class="mono" style="font-size:11px;color:var(--text-tertiary);margin-left:8px;">v1.0</span>
    </div>
    <div class="toolbar-actions">
      <button class="btn btn-ghost btn-sm" id="toggle-theme" title="Toggle theme">
        <i data-lucide="sun-moon" style="width:16px;height:16px;"></i>
        <span>Theme</span>
      </button>
    </div>
  </div>
</div>

<div class="page">

<!-- ─── Masthead ────────────────────────────────────────────── -->
<div class="masthead">
  <div>
    <div class="mono-tag">Applied Labs · aplab.ai · May 2026</div>
    <h1>A calm visual language for a stressful conversation.</h1>
    <p class="subtitle" style="max-width:680px;">
      The tokens and components below are the full vocabulary for Clarity v1.
      Review, tweak, and hand off to the implementing agent with <span class="mono">STYLE_GUIDE.md</span> + <span class="mono">globals.css</span>.
    </p>
  </div>
  <div class="stack" style="align-items:flex-end;">
    <div class="pill pill-turn"><span class="pill-dot"></span>On-spec · light+dark</div>
  </div>
</div>

<nav class="toc">
  <strong style="color:var(--text-primary);font-weight:500;">Contents</strong>
  <a href="#principles">Principles</a>
  <a href="#color">Color</a>
  <a href="#type">Type</a>
  <a href="#scale">Spacing · Radius · Shadow</a>
  <a href="#buttons">Buttons</a>
  <a href="#forms">Forms</a>
  <a href="#chat">Chat bubbles</a>
  <a href="#privacy">Privacy banner</a>
  <a href="#pills">Status pills · Dashboard</a>
  <a href="#synthesis">Synthesis card</a>
  <a href="#draft">Draft Coach panel</a>
  <a href="#solo">Solo mode toggle</a>
  <a href="#dark">Dark mode</a>
  <a href="#rules">Copy rules</a>
</nav>

<!-- ─── Principles ──────────────────────────────────────────── -->
<section id="principles">
  <div class="section-head">
    <div class="kicker">01 · Principles</div>
    <h2>Five rules, in order of priority.</h2>
    <p>When two principles conflict, the earlier one wins. This is how we resolve design disagreements without another meeting.</p>
  </div>
  <div class="grid grid-auto">
    <div class="swatch" style="padding:20px;">
      <div class="mono tertiary" style="font-size:11px;margin-bottom:8px;">01</div>
      <h3 style="margin-bottom:6px;">Calm over clever</h3>
      <p class="muted" style="margin:0;font-size:13px;line-height:1.55;">No saturated colors, no gamification, no celebration motion. The user is stressed — the UI should feel like a breath.</p>
    </div>
    <div class="swatch" style="padding:20px;">
      <div class="mono tertiary" style="font-size:11px;margin-bottom:8px;">02</div>
      <h3 style="margin-bottom:6px;">The human decides</h3>
      <p class="muted" style="margin:0;font-size:13px;line-height:1.55;">Every AI output is a suggestion. The Send button is always a human action — never automatic.</p>
    </div>
    <div class="swatch" style="padding:20px;">
      <div class="mono tertiary" style="font-size:11px;margin-bottom:8px;">03</div>
      <h3 style="margin-bottom:6px;">Privacy is visible</h3>
      <p class="muted" style="margin:0;font-size:13px;line-height:1.55;">If data is private, the screen says so. Trust is earned by showing the seams, not hiding them.</p>
    </div>
    <div class="swatch" style="padding:20px;">
      <div class="mono tertiary" style="font-size:11px;margin-bottom:8px;">04</div>
      <h3 style="margin-bottom:6px;">One primary action</h3>
      <p class="muted" style="margin:0;font-size:13px;line-height:1.55;">Exactly one sage-filled button per screen. Secondary actions are visually subordinated.</p>
    </div>
    <div class="swatch" style="padding:20px;">
      <div class="mono tertiary" style="font-size:11px;margin-bottom:8px;">05</div>
      <h3 style="margin-bottom:6px;">Presence over polish</h3>
      <p class="muted" style="margin:0;font-size:13px;line-height:1.55;">Streaming cursors, live updates, quiet activity. Invest motion in real interaction.</p>
    </div>
  </div>
</section>

<!-- ─── Color ───────────────────────────────────────────────── -->
<section id="color">
  <div class="section-head">
    <div class="kicker">02 · Color</div>
    <h2>Warm neutrals, sage accent, lavender for the AI.</h2>
    <p>Every token is declared as a CSS custom property. Dark mode swaps values; components never reference hex directly.</p>
  </div>

  <h3 style="margin:24px 0 12px;">Neutrals &amp; surfaces</h3>
  <div class="grid grid-4" id="swatches-neutral"></div>

  <h3 style="margin:32px 0 12px;">Accent · Sage (primary action)</h3>
  <div class="grid grid-4" id="swatches-accent"></div>

  <h3 style="margin:32px 0 12px;">Coach · Dusty Lavender (AI identity)</h3>
  <div class="grid grid-4" id="swatches-coach"></div>

  <h3 style="margin:32px 0 12px;">Party colors (joint chat)</h3>
  <div class="grid grid-4" id="swatches-party"></div>

  <h3 style="margin:32px 0 12px;">Feedback</h3>
  <div class="grid grid-4" id="swatches-feedback"></div>

  <h3 style="margin:32px 0 12px;">Tints</h3>
  <div class="grid grid-4" id="swatches-tints"></div>
</section>

<!-- ─── Type ────────────────────────────────────────────────── -->
<section id="type">
  <div class="section-head">
    <div class="kicker">03 · Typography</div>
    <h2>Inter for everything. JetBrains Mono for tokens and IDs.</h2>
    <p>Headings are weight 500, never 700. Bold headings feel shouty in a mediation context.</p>
  </div>

  <div class="swatch" style="padding: 8px 24px;">
    <div class="type-row">
      <div class="type-label">display</div>
      <div style="font-size:32px; line-height: 40px; font-weight: 500; letter-spacing: -0.02em;">A calm place to work through a difficult conversation.</div>
      <div class="type-spec">32 / 40 · 500</div>
    </div>
    <div class="type-row">
      <div class="type-label">h1</div>
      <div style="font-size:24px; line-height: 32px; font-weight: 500; letter-spacing:-0.015em;">Case with Jordan</div>
      <div class="type-spec">24 / 32 · 500</div>
    </div>
    <div class="type-row">
      <div class="type-label">h2</div>
      <div style="font-size:20px; line-height: 28px; font-weight: 500;">Ready for Joint Session</div>
      <div class="type-spec">20 / 28 · 500</div>
    </div>
    <div class="type-row">
      <div class="type-label">h3</div>
      <div style="font-size:17px; line-height: 24px; font-weight: 500;">Areas of likely agreement</div>
      <div class="type-spec">17 / 24 · 500</div>
    </div>
    <div class="type-row">
      <div class="type-label">body</div>
      <div style="font-size:15px; line-height: 1.6;">Coach AI has access to both parties' context and synthesizes themes in its own words. It never quotes the other party's raw private input.</div>
      <div class="type-spec">15 / 1.6 · 400</div>
    </div>
    <div class="type-row">
      <div class="type-label">chat</div>
      <div style="font-size:16px; line-height: 1.55;">Honestly, I'm frustrated. I feel like Jordan doesn't respect my time.</div>
      <div class="type-spec">16 / 1.55 · 400</div>
    </div>
    <div class="type-row">
      <div class="type-label">label</div>
      <div style="font-size:14px; line-height: 20px; font-weight: 500;">What would a good resolution look like?</div>
      <div class="type-spec">14 / 20 · 500</div>
    </div>
    <div class="type-row">
      <div class="type-label">meta</div>
      <div style="font-size:13px; color: var(--text-secondary);">Workplace · Created Apr 15</div>
      <div class="type-spec">13 / 18 · 400 secondary</div>
    </div>
    <div class="type-row">
      <div class="type-label">timestamp</div>
      <div style="font-size:12px; color: var(--text-tertiary);">2 hours ago</div>
      <div class="type-spec">12 / 16 · 400 tertiary</div>
    </div>
    <div class="type-row">
      <div class="type-label">mono</div>
      <div class="mono" style="font-size:14px;">clarity.app/invite/fr8k2q9mz0x1</div>
      <div class="type-spec">JetBrains Mono · 14 / 20</div>
    </div>
  </div>
</section>

<!-- ─── Spacing / Radius / Shadow ───────────────────────────── -->
<section id="scale">
  <div class="section-head">
    <div class="kicker">04 · Spacing · Radius · Shadow</div>
    <h2>8-point grid. Four shadow levels.</h2>
  </div>

  <div class="grid grid-3">
    <div>
      <h3 style="margin-bottom:12px;">Spacing</h3>
      <div class="swatch" style="padding: 12px 20px;" id="spacing-scale"></div>
    </div>
    <div>
      <h3 style="margin-bottom:12px;">Radius</h3>
      <div class="swatch" style="padding: 20px; display:flex; flex-direction:column; gap:16px;" id="radius-scale"></div>
    </div>
    <div>
      <h3 style="margin-bottom:12px;">Shadow</h3>
      <div class="stack">
        <div class="shadow-block" style="box-shadow: var(--shadow-0);">shadow-0 · flat</div>
        <div class="shadow-block" style="box-shadow: var(--shadow-1);">shadow-1 · cards</div>
        <div class="shadow-block" style="box-shadow: var(--shadow-2);">shadow-2 · popovers</div>
        <div class="shadow-block" style="box-shadow: var(--shadow-3);">shadow-3 · modals</div>
      </div>
    </div>
  </div>
</section>

<!-- ─── Buttons ─────────────────────────────────────────────── -->
<section id="buttons">
  <div class="section-head">
    <div class="kicker">05 · Buttons</div>
    <h2>One sage-filled primary per screen. Everything else subordinated.</h2>
  </div>

  <div class="grid grid-2">
    <div class="swatch" style="padding:28px;">
      <div class="mono tertiary" style="font-size:11px;margin-bottom:16px;">VARIANTS</div>
      <div class="row">
        <button class="btn btn-primary"><i data-lucide="send" style="width:16px;height:16px;"></i>Send message</button>
        <button class="btn btn-secondary">Cancel</button>
        <button class="btn btn-ghost">Learn more</button>
        <button class="btn btn-danger"><i data-lucide="x" style="width:16px;height:16px;"></i>Close case</button>
      </div>
      <div class="mono tertiary" style="font-size:11px;margin:24px 0 16px;">LINK</div>
      <div class="row">
        <a href="#" style="font-size:14px;">How does privacy work?</a>
      </div>
    </div>

    <div class="swatch" style="padding:28px;">
      <div class="mono tertiary" style="font-size:11px;margin-bottom:16px;">SIZES</div>
      <div class="row">
        <button class="btn btn-primary btn-sm">Small</button>
        <button class="btn btn-primary">Medium</button>
        <button class="btn btn-primary btn-lg">Large</button>
      </div>
      <div class="mono tertiary" style="font-size:11px;margin:24px 0 16px;">STATES</div>
      <div class="row">
        <button class="btn btn-primary">Default</button>
        <button class="btn btn-primary" style="background:var(--accent-hover);border-color:var(--accent-hover);">Hover</button>
        <button class="btn btn-primary" disabled>Disabled</button>
      </div>
      <div class="mono tertiary" style="font-size:11px;margin:24px 0 16px;">ICON</div>
      <div class="row">
        <button class="btn btn-secondary btn-icon" aria-label="Copy"><i data-lucide="copy" style="width:16px;height:16px;"></i></button>
        <button class="btn btn-secondary btn-icon" aria-label="Close"><i data-lucide="x" style="width:16px;height:16px;"></i></button>
        <button class="btn btn-secondary btn-icon" aria-label="Sparkles"><i data-lucide="sparkles" style="width:16px;height:16px;"></i></button>
      </div>
    </div>
  </div>
</section>

<!-- ─── Forms ───────────────────────────────────────────────── -->
<section id="forms">
  <div class="section-head">
    <div class="kicker">06 · Forms</div>
    <h2>Structured intake that doesn't feel like a tax form.</h2>
  </div>

  <div class="grid grid-2">
    <div class="swatch" style="padding: 28px;">
      <div class="mono tertiary" style="font-size:11px;margin-bottom:16px;">INPUT · TEXTAREA · SELECT</div>
      <div class="stack">
        <div>
          <label class="label">Their name</label>
          <input class="input" placeholder="Jordan" />
          <span class="helper">Just a first name or nickname is fine.</span>
        </div>
        <div>
          <label class="label">In one sentence, what's this about?</label>
          <textarea class="textarea" rows="2">We disagree on the project deadline and the scope that fits inside it.</textarea>
          <span class="helper">Visible to the other person when they accept the invitation. Keep it factual, not emotional.</span>
        </div>
        <div>
          <label class="label">Category</label>
          <select class="select">
            <option>Workplace</option>
            <option>Family</option>
            <option>Personal</option>
            <option>Contractual / business</option>
            <option>Other</option>
          </select>
        </div>
        <div>
          <label class="label">Your email</label>
          <input class="input" aria-invalid="true" value="alex@example" />
          <span class="error">That doesn't look like a valid email.</span>
        </div>
      </div>
    </div>

    <div class="swatch" style="padding: 28px;">
      <div class="mono tertiary" style="font-size:11px;margin-bottom:16px;">RADIO CARDS (CATEGORY PICKER)</div>
      <div class="stack">
        <div class="radio-card" data-selected="true">
          <i data-lucide="briefcase" style="width:20px;height:20px;" class="icon"></i>
          <div>
            <div class="title">Workplace</div>
            <div class="desc">Coworker, manager, cofounder, or teammate friction.</div>
          </div>
        </div>
        <div class="radio-card">
          <i data-lucide="home" style="width:20px;height:20px;" class="icon"></i>
          <div>
            <div class="title">Family</div>
            <div class="desc">Partner, parent, sibling, or in-law disagreement.</div>
          </div>
        </div>
        <div class="radio-card">
          <i data-lucide="users" style="width:20px;height:20px;" class="icon"></i>
          <div>
            <div class="title">Personal relationship</div>
            <div class="desc">Friend, roommate, or community dispute.</div>
          </div>
        </div>
        <div class="radio-card">
          <i data-lucide="file-text" style="width:20px;height:20px;" class="icon"></i>
          <div>
            <div class="title">Contractual / business</div>
            <div class="desc">Freelance, vendor, or agreement dispute.</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ─── Chat bubbles ────────────────────────────────────────── -->
<section id="chat">
  <div class="section-head">
    <div class="kicker">07 · Chat bubbles</div>
    <h2>Every voice has its own color.</h2>
    <p>User = surface white · Private Coach = sage · Joint Coach = lavender (left-border) · Alex = soft blue · Jordan = soft rose · Error = muted terracotta.</p>
  </div>

  <div class="chat-frame">
    <div class="phase-header">
      <a class="phase-header-back" href="#"><i data-lucide="arrow-left" style="width:14px;height:14px;"></i>Dashboard</a>
      <div class="phase-header-title">
        <span>Case with Jordan</span>
        <span class="phase-header-sep">·</span>
        <span class="phase-header-phase">Private Coaching</span>
      </div>
    </div>
    <div class="banner-privacy">
      <i data-lucide="lock" style="width:16px;height:16px;" class="icon"></i>
      <div><strong>This conversation is private to you.</strong> Jordan will never see any of it. <a href="#">Learn more</a></div>
    </div>
    <div class="chat-body">

      <div class="chat-row">
        <div class="avatar avatar-coach">C</div>
        <div class="chat-stack">
          <span class="chat-author">Coach</span>
          <div class="bubble bubble-coach">
            Hi Alex. I'm here to help you think through what's going on. Before we get into specifics, I'd like to understand how you're feeling right now. Can you describe that?
          </div>
          <span class="chat-timestamp">10:24 AM</span>
        </div>
      </div>

      <div class="chat-row chat-row-right">
        <div class="avatar avatar-you">A</div>
        <div class="chat-stack">
          <div class="bubble">
            Honestly, I'm frustrated. I feel like Jordan doesn't respect my time.
          </div>
          <span class="chat-timestamp">10:26 AM</span>
        </div>
      </div>

      <div class="chat-row">
        <div class="avatar avatar-coach">C</div>
        <div class="chat-stack">
          <span class="chat-author">Coach</span>
          <div class="bubble bubble-coach">
            That's helpful context. Can you tell me about a recent moment when you felt that way<span class="cursor"></span>
          </div>
        </div>
      </div>

      <div class="chat-row">
        <div class="avatar avatar-coach">C</div>
        <div class="chat-stack">
          <span class="chat-author">Coach</span>
          <div class="bubble bubble-error">
            <i data-lucide="alert-triangle" style="width:16px;height:16px;color:var(--danger);"></i>
            <span>Coach is unavailable right now.</span>
            <button class="btn btn-sm btn-secondary" style="margin-left:auto;">Retry</button>
          </div>
        </div>
      </div>

    </div>
  </div>

  <h3 style="margin:40px 0 16px;">Joint chat — Coach intervention</h3>
  <div class="chat-frame">
    <div class="phase-header">
      <a class="phase-header-back" href="#"><i data-lucide="arrow-left" style="width:14px;height:14px;"></i>Dashboard</a>
      <div class="phase-header-title">
        <span>Case with Jordan</span>
        <span class="phase-header-sep">·</span>
        <span class="phase-header-phase">Joint Session</span>
      </div>
      <div style="margin-left:auto;" class="row">
        <button class="btn btn-ghost btn-sm"><i data-lucide="book-open" style="width:14px;height:14px;"></i>My guidance</button>
        <button class="btn btn-secondary btn-sm">Close</button>
      </div>
    </div>
    <div class="chat-body">
      <div class="chat-row">
        <div class="avatar avatar-invitee">J</div>
        <div class="chat-stack">
          <span class="chat-author">Jordan</span>
          <div class="bubble bubble-party-invitee">
            Hey Alex. I want to start by saying I hear you on the timing thing. I've been sitting with that since we last talked.
          </div>
        </div>
      </div>
      <div class="chat-row chat-row-right">
        <div class="avatar avatar-initiator">A</div>
        <div class="chat-stack">
          <div class="bubble bubble-party-initiator">
            Thanks, Jordan. I appreciate that. Here's where I'm at — the deadline itself isn't flexible on my side, but I know scope might be.
          </div>
        </div>
      </div>
      <div class="chat-row">
        <div class="avatar avatar-coach">⟡</div>
        <div class="chat-stack">
          <span class="chat-author">Coach</span>
          <div class="bubble bubble-coach-intervention">
            A point of agreement is starting to emerge — you both want this to succeed and you're both flexible on at least one variable. Want to name the specific constraint next?
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ─── Privacy banner / iconography ────────────────────────── -->
<section id="privacy">
  <div class="section-head">
    <div class="kicker">08 · Privacy banner &amp; lock iconography</div>
    <h2>Privacy is never implied. It is labeled.</h2>
  </div>
  <div class="stack">
    <div class="swatch" style="padding: 0; overflow:hidden;">
      <div class="banner-privacy">
        <i data-lucide="lock" style="width:16px;height:16px;" class="icon"></i>
        <div><strong>Private to you.</strong> Only you and the AI coach will see this. <a href="#">Learn more about privacy</a></div>
      </div>
    </div>
    <div class="swatch" style="padding: 0; overflow:hidden;">
      <div class="banner-privacy" style="background:var(--warning-subtle);border-bottom-color:var(--warning);">
        <i data-lucide="shield-alert" style="width:16px;height:16px;color:var(--warning);" class="icon"></i>
        <div><strong style="color:var(--text-primary);">Heads up —</strong> the Coach flagged this message as potentially inflammatory. You can take a moment, or send it as-is.</div>
      </div>
    </div>
    <div class="row" style="gap:16px;">
      <div class="row" style="gap:8px;"><i data-lucide="lock" style="width:16px;height:16px;color:var(--text-secondary);"></i><span class="muted">Private to you</span></div>
      <div class="row" style="gap:8px;"><i data-lucide="shield-check" style="width:16px;height:16px;color:var(--accent);"></i><span class="muted">Coach-verified</span></div>
      <div class="row" style="gap:8px;"><i data-lucide="users" style="width:16px;height:16px;color:var(--text-secondary);"></i><span class="muted">Shared with Jordan</span></div>
      <div class="row" style="gap:8px;"><i data-lucide="sparkles" style="width:16px;height:16px;color:var(--coach-accent);"></i><span class="muted">Coach message</span></div>
    </div>
  </div>
</section>

<!-- ─── Status pills / Dashboard ────────────────────────────── -->
<section id="pills">
  <div class="section-head">
    <div class="kicker">09 · Status pills · Dashboard row</div>
    <h2>One glyph per state, works at any size.</h2>
  </div>

  <div class="row" style="margin-bottom: 24px;">
    <span class="pill pill-turn"><span class="pill-dot"></span>Your turn</span>
    <span class="pill pill-waiting"><span class="pill-dot"></span>Waiting on Jordan</span>
    <span class="pill pill-ready"><span class="pill-dot"></span>Ready for joint session</span>
    <span class="pill pill-closed"><span class="pill-dot"></span>Resolved</span>
  </div>

  <div class="stack">
    <div class="case-row">
      <div class="avatar avatar-invitee" style="width:40px;height:40px;font-size:15px;">J</div>
      <div>
        <div class="title">Case with Jordan</div>
        <div class="meta">Workplace · Created Apr 15</div>
        <div class="status"><span class="pill pill-turn"><span class="pill-dot"></span>Your turn — continue private coaching</span></div>
        <div class="last">Last activity: 2 hours ago</div>
      </div>
      <button class="btn btn-secondary btn-sm">Enter <i data-lucide="arrow-right" style="width:14px;height:14px;"></i></button>
    </div>
    <div class="case-row">
      <div class="avatar avatar-invitee" style="width:40px;height:40px;font-size:15px;">S</div>
      <div>
        <div class="title">Case with Sam</div>
        <div class="meta">Family · Created Apr 10</div>
        <div class="status"><span class="pill pill-waiting"><span class="pill-dot"></span>Waiting on Sam to finish private coaching</span></div>
        <div class="last">Last activity: yesterday</div>
      </div>
      <button class="btn btn-ghost btn-sm">View</button>
    </div>
    <div class="case-row">
      <div class="avatar avatar-invitee" style="width:40px;height:40px;font-size:15px;">R</div>
      <div>
        <div class="title">Case with Riley</div>
        <div class="meta">Personal · Created Apr 3</div>
        <div class="status"><span class="pill pill-ready"><span class="pill-dot"></span>Ready to enter joint session</span></div>
        <div class="last">Last activity: 4 days ago</div>
      </div>
      <button class="btn btn-primary btn-sm">Enter <i data-lucide="arrow-right" style="width:14px;height:14px;"></i></button>
    </div>
    <div class="case-row" style="opacity: .75;">
      <div class="avatar" style="width:40px;height:40px;font-size:15px;background:var(--text-tertiary);">T</div>
      <div>
        <div class="title">Case with Taylor</div>
        <div class="meta">Contractual · Closed Mar 28</div>
        <div class="status"><span class="pill pill-closed"><span class="pill-dot"></span>Resolved</span></div>
        <div class="last">Last activity: 3 weeks ago</div>
      </div>
      <button class="btn btn-ghost btn-sm">View archive</button>
    </div>
  </div>
</section>

<!-- ─── Synthesis card ──────────────────────────────────────── -->
<section id="synthesis">
  <div class="section-head">
    <div class="kicker">10 · Synthesis card</div>
    <h2>The moment of pause before the joint session.</h2>
    <p>Displayed on the "Ready for Joint" screen. Generated per-party, never containing raw quotes from the other party.</p>
  </div>

  <div style="max-width:720px;">
    <div class="banner-privacy" style="border-bottom-left-radius:0;border-bottom-right-radius:0;border:1px solid var(--border-default);border-bottom:0;border-radius:var(--radius-lg) var(--radius-lg) 0 0;">
      <i data-lucide="lock" style="width:16px;height:16px;" class="icon"></i>
      <div><strong>Private to you</strong> — Jordan has their own version.</div>
    </div>
    <div class="synthesis" style="border-top-left-radius:0;border-top-right-radius:0;border-top:0;">
      <h3>Areas of likely agreement</h3>
      <p>Both of you value the project's success, and both recognize the current timing tension is solvable. There's more common ground here than either of you may feel in the moment.</p>
      <h3>Points that will need real discussion</h3>
      <p>There's a genuine difference in how each of you prioritizes scope versus deadline. Expect to spend time on the trade-off, not just the calendar.</p>
      <h3>Suggested approach</h3>
      <p>Start by acknowledging what's working before raising the constraint question. Be specific about your hard dates; keep scope open as the shared variable.</p>
      <div style="margin-top:32px; display:flex; justify-content:center;">
        <button class="btn btn-primary btn-lg">Enter joint session<i data-lucide="arrow-right" style="width:16px;height:16px;"></i></button>
      </div>
    </div>
  </div>
</section>

<!-- ─── Draft Coach ─────────────────────────────────────────── -->
<section id="draft">
  <div class="section-head">
    <div class="kicker">11 · Draft Coach panel</div>
    <h2>The human is always the one who clicks Send.</h2>
    <p>Draft Coach never auto-posts. It helps, reviews, and hands off — the user sends.</p>
  </div>

  <div class="grid grid-2" style="align-items:flex-start;">
    <div class="drawer">
      <div class="drawer-header">
        <div class="drawer-header-title">
          <i data-lucide="sparkles" style="width:16px;height:16px;color:var(--coach-accent);"></i>
          Draft Coach
          <i data-lucide="lock" style="width:14px;height:14px;color:var(--text-tertiary);margin-left:4px;"></i>
        </div>
        <button class="btn btn-ghost btn-icon" aria-label="Close"><i data-lucide="x" style="width:16px;height:16px;"></i></button>
      </div>
      <div class="banner-privacy">
        <i data-lucide="lock" style="width:16px;height:16px;" class="icon"></i>
        <div>Jordan can't see what you discuss here. Only the final message you send goes to the joint chat.</div>
      </div>
      <div class="drawer-body">
        <div class="chat-row">
          <div class="avatar avatar-sm avatar-coach" style="width:24px;height:24px;font-size:11px;">C</div>
          <div class="chat-stack">
            <div class="bubble bubble-coach" style="font-size:14px;">What are you trying to say next?</div>
          </div>
        </div>
        <div class="chat-row chat-row-right">
          <div class="avatar avatar-sm avatar-you" style="width:24px;height:24px;font-size:11px;">A</div>
          <div class="chat-stack">
            <div class="bubble" style="font-size:14px;">I want to push back on the deadline but without sounding like I'm blaming them.</div>
          </div>
        </div>
        <div class="chat-row">
          <div class="avatar avatar-sm avatar-coach" style="width:24px;height:24px;font-size:11px;">C</div>
          <div class="chat-stack">
            <div class="bubble bubble-coach" style="font-size:14px;">Good instinct. What's the actual constraint you need them to hear<span class="cursor"></span></div>
          </div>
        </div>
      </div>
      <div class="drawer-footer">
        <textarea class="textarea" rows="2" placeholder="Keep the coaching conversation going…" style="min-height:44px;font-size:14px;"></textarea>
        <div class="row" style="margin-top:8px;justify-content:space-between;">
          <button class="btn btn-ghost btn-sm">Keep refining</button>
          <button class="btn btn-primary btn-sm"><i data-lucide="sparkles" style="width:14px;height:14px;"></i>Draft it for me</button>
        </div>
      </div>
    </div>

    <div class="drawer">
      <div class="drawer-header">
        <div class="drawer-header-title">
          <i data-lucide="sparkles" style="width:16px;height:16px;color:var(--coach-accent);"></i>
          Draft Coach
          <i data-lucide="lock" style="width:14px;height:14px;color:var(--text-tertiary);margin-left:4px;"></i>
        </div>
        <button class="btn btn-ghost btn-icon" aria-label="Close"><i data-lucide="x" style="width:16px;height:16px;"></i></button>
      </div>
      <div class="drawer-body">
        <p class="muted" style="margin:0 0 12px;font-size:13px;">Here's a draft based on what we talked about:</p>
        <div class="draft-ready">
          "Hey Jordan — I want to be straight with you about the deadline. The constraint isn't ambition, it's that I have a hard commitment on April 30 that I can't move. Can we work backwards from there together?"
        </div>
        <div class="stack">
          <button class="btn btn-primary" style="width:100%;justify-content:center;"><i data-lucide="send" style="width:16px;height:16px;"></i>Send this message</button>
          <button class="btn btn-secondary" style="width:100%;justify-content:center;"><i data-lucide="pencil" style="width:16px;height:16px;"></i>Edit before sending</button>
          <button class="btn btn-ghost" style="width:100%;justify-content:center;"><i data-lucide="refresh-cw" style="width:16px;height:16px;"></i>Keep refining with Coach</button>
          <button class="btn btn-ghost" style="width:100%;justify-content:center;color:var(--danger);"><i data-lucide="trash-2" style="width:16px;height:16px;"></i>Discard</button>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ─── Solo mode ───────────────────────────────────────────── -->
<section id="solo">
  <div class="section-head">
    <div class="kicker">12 · Solo mode party toggle</div>
    <h2>Distinctive by design — no tester confuses solo with real.</h2>
  </div>
  <div class="phase-header" style="border:1px solid var(--border-default);border-radius:var(--radius-lg);">
    <a class="phase-header-back" href="#"><i data-lucide="arrow-left" style="width:14px;height:14px;"></i>Dashboard</a>
    <div class="phase-header-title">
      <span>Solo Test Case</span>
      <span class="phase-header-sep">·</span>
      <span class="phase-header-phase">Private Coaching</span>
    </div>
    <div class="party-toggle" style="margin-left:auto;">
      <span class="party-toggle-label">Viewing as</span>
      <button class="party-toggle-btn" data-active="true">Alex</button>
      <button class="party-toggle-btn">Jordan</button>
    </div>
  </div>
</section>

<!-- ─── Dark mode — dual pane ───────────────────────────────── -->
<section id="dark">
  <div class="section-head">
    <div class="kicker">13 · Dark mode parity</div>
    <h2>Same palette, inverted luminance, same warmth.</h2>
    <p>Every surface, bubble, and pill has a tested dark counterpart. Shadows scale up in alpha to stay visible.</p>
  </div>

  <div class="dual">
    <div class="dual-pane scope-light">
      <div class="dual-label">LIGHT</div>
      <div class="pane-body">
        <div class="banner-privacy" style="border-radius:var(--radius-md);margin-bottom:16px;">
          <i data-lucide="lock" style="width:16px;height:16px;" class="icon"></i>
          <div><strong>Private to you.</strong> Jordan can't see this.</div>
        </div>
        <div class="chat-row">
          <div class="avatar avatar-coach">C</div>
          <div class="chat-stack">
            <div class="bubble bubble-coach">Can you tell me about a recent moment?</div>
          </div>
        </div>
        <div class="chat-row chat-row-right">
          <div class="avatar avatar-you">A</div>
          <div class="chat-stack">
            <div class="bubble">It was in Monday's standup — I felt dismissed.</div>
          </div>
        </div>
        <div class="row" style="margin-top: 16px; gap:8px;">
          <button class="btn btn-primary btn-sm">Send</button>
          <button class="btn btn-secondary btn-sm">Cancel</button>
          <span class="pill pill-turn"><span class="pill-dot"></span>Your turn</span>
        </div>
      </div>
    </div>

    <div class="dual-pane scope-dark">
      <div class="dual-label" style="color:var(--text-tertiary);">DARK</div>
      <div class="pane-body">
        <div class="banner-privacy" style="border-radius:var(--radius-md);margin-bottom:16px;">
          <i data-lucide="lock" style="width:16px;height:16px;" class="icon"></i>
          <div><strong>Private to you.</strong> Jordan can't see this.</div>
        </div>
        <div class="chat-row">
          <div class="avatar avatar-coach">C</div>
          <div class="chat-stack">
            <div class="bubble bubble-coach">Can you tell me about a recent moment?</div>
          </div>
        </div>
        <div class="chat-row chat-row-right">
          <div class="avatar avatar-you">A</div>
          <div class="chat-stack">
            <div class="bubble">It was in Monday's standup — I felt dismissed.</div>
          </div>
        </div>
        <div class="row" style="margin-top: 16px; gap:8px;">
          <button class="btn btn-primary btn-sm">Send</button>
          <button class="btn btn-secondary btn-sm">Cancel</button>
          <span class="pill pill-turn"><span class="pill-dot"></span>Your turn</span>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ─── Copy rules ──────────────────────────────────────────── -->
<section id="rules">
  <div class="section-head">
    <div class="kicker">14 · Copy rules</div>
    <h2>Content is design.</h2>
  </div>
  <div class="grid grid-2">
    <div class="swatch" style="padding: 24px;">
      <div class="mono tertiary" style="font-size:11px;margin-bottom:12px;">NEVER USE</div>
      <ul class="stack" style="gap:6px;padding:0;margin:0;list-style:none;font-size:14px;color:var(--danger);">
        <li>— "arbiter", "verdict", "judgment"</li>
        <li>— "the parties" (use names instead)</li>
        <li>— 🎉 or exclamation marks from the AI</li>
        <li>— "Get started free", pricing language</li>
        <li>— "Congratulations on resolving your conflict!"</li>
      </ul>
    </div>
    <div class="swatch" style="padding: 24px;">
      <div class="mono tertiary" style="font-size:11px;margin-bottom:12px;">USE INSTEAD</div>
      <ul class="stack" style="gap:6px;padding:0;margin:0;list-style:none;font-size:14px;color:var(--accent);">
        <li>— "coach", "guidance", "synthesis", "resolution"</li>
        <li>— "You and Jordan"</li>
        <li>— Steady, curious tone. The AI offers, suggests, wonders.</li>
        <li>— Plain description of what the product does.</li>
        <li>— "Case closed."</li>
      </ul>
    </div>
  </div>
</section>

<div class="muted" style="text-align:center;padding-top:48px;border-top:1px solid var(--border-default);">
  <div class="mono" style="font-size:11px;color:var(--text-tertiary);">Clarity · Style Guide v1.0 · Applied Labs · May 2026</div>
</div>

</div><!-- /.page -->

<!-- ─── Tweaks panel ────────────────────────────────────────── -->
<div class="tweaks" id="tweaks">
  <h3>Tweaks</h3>
  <div class="tweaks-field">
    <label>Theme</label>
    <div class="segmented" data-key="theme">
      <button data-v="light" data-active="true">Light</button>
      <button data-v="dark">Dark</button>
    </div>
  </div>
  <div class="tweaks-field">
    <label>Palette variant</label>
    <div class="segmented" data-key="variant">
      <button data-v="default" data-active="true">Warm Sage</button>
      <button data-v="slate">Slate Neutral</button>
      <button data-v="earth">Deeper Earth</button>
    </div>
  </div>
  <p class="muted" style="font-size:11px;margin:0;line-height:1.5;">
    "Warm Sage" is the spec default. The two alternates are tasteful explorations — same structural tokens, shifted hues and contrast.
  </p>
</div>

<script>
/* Init lucide icons */
lucide.createIcons();

/* ─── Swatch data ─────────────────────────────────────────── */
const swatches = {
  neutral: [
    ["Canvas", "--bg-canvas", "#FAF8F5"],
    ["Surface", "--bg-surface", "#FFFFFF"],
    ["Surface subtle", "--bg-surface-subtle", "#F3EFE9"],
    ["Text primary", "--text-primary", "#1F1D1A"],
    ["Text secondary", "--text-secondary", "#5C5952"],
    ["Text tertiary", "--text-tertiary", "#8A8680"],
    ["Border default", "--border-default", "#E5E0D8"],
    ["Border strong", "--border-strong", "#CBC4B8"],
  ],
  accent: [
    ["Accent", "--accent", "#6B8E7F"],
    ["Accent hover", "--accent-hover", "#5A7A6C"],
    ["Accent subtle", "--accent-subtle", "#DCE7E0"],
    ["Accent on", "--accent-on", "#FFFFFF"],
  ],
  coach: [
    ["Coach accent", "--coach-accent", "#8B7AB5"],
    ["Coach subtle", "--coach-subtle", "#EAE4F2"],
  ],
  party: [
    ["Initiator", "--party-initiator", "#6B85A8"],
    ["Initiator subtle", "--party-initiator-subtle", "#DFE5EF"],
    ["Invitee", "--party-invitee", "#B07A8F"],
    ["Invitee subtle", "--party-invitee-subtle", "#EFE0E4"],
  ],
  feedback: [
    ["Danger", "--danger", "#B5594D"],
    ["Danger subtle", "--danger-subtle", "#F2DCD8"],
    ["Warning", "--warning", "#B58B4D"],
    ["Warning subtle", "--warning-subtle", "#F2E5D4"],
  ],
  tints: [
    ["Private tint", "--private-tint", "#F0E9E0"],
  ],
};

function mountSwatches(id, rows) {
  const host = document.getElementById(id);
  if (!host) return;
  host.innerHTML = rows.map(([name, token, hex]) => `
    <div class="swatch">
      <div class="swatch-chip" style="background: var(${token});"></div>
      <div class="swatch-body">
        <div class="swatch-name">${name}</div>
        <div class="swatch-token">${token}</div>
        <div class="swatch-hex">${hex}</div>
      </div>
    </div>
  `).join("");
}
mountSwatches("swatches-neutral", swatches.neutral);
mountSwatches("swatches-accent", swatches.accent);
mountSwatches("swatches-coach", swatches.coach);
mountSwatches("swatches-party", swatches.party);
mountSwatches("swatches-feedback", swatches.feedback);
mountSwatches("swatches-tints", swatches.tints);

/* ─── Spacing scale ───────────────────────────────────────── */
const spacingHost = document.getElementById("spacing-scale");
[4,8,12,16,20,24,32,40,48,64].forEach(px => {
  const row = document.createElement("div");
  row.className = "scale-row";
  row.innerHTML = `<span class="mono">${px}px</span><div class="scale-block" style="width:${px*2}px;"></div>`;
  spacingHost.appendChild(row);
});

/* ─── Radius scale ────────────────────────────────────────── */
const radiusHost = document.getElementById("radius-scale");
[["sm","6px"],["md","10px"],["lg","14px"],["xl","20px"]].forEach(([name, v]) => {
  const row = document.createElement("div");
  row.className = "row";
  row.style.gap = "16px";
  row.innerHTML = `
    <div class="radius-block" style="border-radius:${v};"></div>
    <div>
      <div style="font-weight:500;font-size:14px;">--radius-${name}</div>
      <div class="mono tertiary" style="font-size:12px;">${v}</div>
    </div>
  `;
  radiusHost.appendChild(row);
});

/* ─── Theme toggle ────────────────────────────────────────── */
const root = document.documentElement;
function setTheme(t){
  root.setAttribute("data-theme", t);
  try { localStorage.setItem("cc-sg-theme", t); } catch {}
  document.querySelectorAll('[data-key="theme"] button').forEach(b => {
    b.setAttribute("data-active", b.dataset.v === t ? "true" : "false");
  });
}
function setVariant(v){
  root.setAttribute("data-variant", v);
  try { localStorage.setItem("cc-sg-variant", v); } catch {}
  document.querySelectorAll('[data-key="variant"] button').forEach(b => {
    b.setAttribute("data-active", b.dataset.v === v ? "true" : "false");
  });
}

try {
  const t = localStorage.getItem("cc-sg-theme");
  if (t) setTheme(t);
  const v = localStorage.getItem("cc-sg-variant");
  if (v) setVariant(v);
} catch {}

document.getElementById("toggle-theme").addEventListener("click", () => {
  setTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark");
});

document.querySelectorAll(".tweaks .segmented").forEach(group => {
  group.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const key = group.dataset.key;
    if (key === "theme") setTheme(btn.dataset.v);
    if (key === "variant") setVariant(btn.dataset.v);
  });
});

/* ─── Tweaks host protocol ────────────────────────────────── */
const tweaksEl = document.getElementById("tweaks");
window.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "__activate_edit_mode") tweaksEl.classList.add("open");
  if (d.type === "__deactivate_edit_mode") tweaksEl.classList.remove("open");
});
try { window.parent.postMessage({type:"__edit_mode_available"}, "*"); } catch {}
</script>
</body>
</html>

```
