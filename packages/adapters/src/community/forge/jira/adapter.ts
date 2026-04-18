/**
 * Jira platform adapter using REST API v3 and webhooks.
 *
 * Community forge adapter — see packages/adapters/src/community/forge/README.md
 *
 * Translates four Jira webhook event types into a single deterministic slash
 * command, `/workflow run jira-router <json>`, and hands it off to the
 * existing orchestrator dispatch path. All routing logic lives in the
 * user-authored `jira-router.yaml` workflow — this adapter has no knowledge
 * of which downstream workflow should run for which event.
 *
 * Handled events (when the issue's project key is mapped to a registered
 * Archon codebase):
 *   - jira:issue_created                      → event: "created"
 *   - jira:issue_updated (status changelog)   → event: "transition"
 *   - jira:issue_updated (summary/description)→ event: "content_changed"
 *   - comment_created                         → event: "comment_created"
 *
 * The JSON payload is appended verbatim (no quoting, no encoding). This
 * works because the orchestrator's tokenizer
 * (`parseCommand` in `packages/core/src/handlers/command-handler.ts`) splits
 * on whitespace via `\S+`, and `handleWorkflowRunCommand` reassembles
 * `args.slice(2).join(' ')` before handing the string to the workflow.
 * Apostrophes and double-quotes inside JSON values are safe — the greedy
 * `\S+` alternative wins at the leading `{`, so the tokenizer never
 * attempts to match quote-delimited substrings mid-JSON. The one
 * cosmetic cost: multiple consecutive spaces inside string values
 * collapse to a single space on the round-trip. This never affects
 * routing keys (event, to_status, etc., all whitespace-free) and is
 * acceptable for summary/body content.
 *
 * Self-triggering is prevented for comment events via the BOT_RESPONSE_MARKER
 * appended to outbound comments, plus an optional bot accountId match.
 *
 * Authorization (optional) is enforced at the event level via
 * JIRA_ALLOWED_ACCOUNT_IDS — empty list means open access.
 *
 * Codebase resolution is explicit: Jira project keys map to registered
 * Archon codebase names via `jira.projects` in `~/.archon/config.yaml`
 * (or `.archon/config.yaml`). Unmapped projects log a warning and abort.
 *
 * Concurrency: fire-and-forget. Multiple events for the same ticket may
 * produce concurrent workflow runs. The router workflow is responsible for
 * reconciliation (inspect artifacts on entry, guard transitions on exit).
 */
import { createHmac, timingSafeEqual } from 'crypto';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import {
  ConversationNotFoundError,
  handleMessage,
  classifyAndFormatError,
  toError,
} from '@archon/core';
import { createLogger } from '@archon/paths';
import * as db from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import { isJiraUserAuthorized } from './auth';
import { splitIntoParagraphChunks } from '../../../utils/message-splitting';
import {
  extractPlainText,
  type AdfDocument,
  type JiraChangelogItem,
  type JiraIssue,
  type JiraWebhookEvent,
} from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.jira');
  return cachedLog;
}

const MAX_LENGTH = 32000; // Practical limit for Jira comments

/** Hidden marker added to bot comments to prevent self-triggering loops */
const BOT_RESPONSE_MARKER = '<!-- archon-bot-response -->';

/** Project key format: uppercase alphanumeric + underscore, hyphen, then digits */
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]+-\d+$/;

/**
 * Router workflow that every Jira webhook dispatches to. Must exist as
 * `jira-router.yaml` in the user's workflow directories (repo or
 * `~/.archon/.archon/workflows/`). Not shipped as a bundled default —
 * deliberately user-authored content, since the routing logic is a
 * per-organization SDLC contract, not adapter code.
 */
const ROUTER_WORKFLOW_NAME = 'jira-router';

export interface JiraAdapterOptions {
  botMention?: string;
  botAccountId?: string;
  allowedAccountIds?: string[];
  /** Map of Jira project key (e.g. "PROJ") → registered codebase name. */
  projectCodebaseMap?: Record<string, string>;
}

interface ParsedCommentEvent {
  kind: 'comment_created';
  issue: JiraIssue;
  body: string;
  authorAccountId?: string;
}

interface ParsedCreatedEvent {
  kind: 'created';
  issue: JiraIssue;
}

interface ParsedTransitionEvent {
  kind: 'transition';
  issue: JiraIssue;
  fromStatus: string;
  toStatus: string;
  actor?: string;
}

interface ParsedContentChangedEvent {
  kind: 'content_changed';
  issue: JiraIssue;
  fields: { field: string; value: string }[];
  actor?: string;
}

type ParsedEvent =
  | ParsedCommentEvent
  | ParsedCreatedEvent
  | ParsedTransitionEvent
  | ParsedContentChangedEvent;

/** Structured JSON payload handed to the router workflow as its sole argument. */
interface RouterEventPayload {
  event: 'comment_created' | 'created' | 'transition' | 'content_changed';
  issue_key: string;
  project: string;
  issue_type?: string;
  summary: string;
  status?: string;
  from_status?: string;
  to_status?: string;
  field?: string;
  new_value?: string;
  comment_body?: string;
  author_account_id?: string;
  actor?: string;
}

export class JiraAdapter implements IPlatformAdapter {
  private readonly baseUrl: string;
  private readonly userEmail: string;
  private readonly apiToken: string;
  private readonly webhookSecret: string;
  private readonly authHeader: string;
  private readonly botMention: string;
  private readonly botAccountId: string | undefined;
  private readonly allowedAccountIds: string[];
  private readonly projectCodebaseMap: Record<string, string>;

  constructor(
    baseUrl: string,
    userEmail: string,
    apiToken: string,
    webhookSecret: string,
    options: JiraAdapterOptions = {}
  ) {
    if (!baseUrl) throw new Error('JiraAdapter requires a non-empty baseUrl');
    if (!userEmail) throw new Error('JiraAdapter requires a non-empty userEmail');
    if (!apiToken) throw new Error('JiraAdapter requires a non-empty apiToken');
    if (!webhookSecret) throw new Error('JiraAdapter requires a non-empty webhookSecret');

    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.userEmail = userEmail;
    this.apiToken = apiToken;
    this.webhookSecret = webhookSecret;
    this.botMention = options.botMention ?? 'Archon';
    this.botAccountId = options.botAccountId;
    this.allowedAccountIds = options.allowedAccountIds ?? [];
    this.projectCodebaseMap = options.projectCodebaseMap ?? {};

    this.authHeader =
      'Basic ' + Buffer.from(`${this.userEmail}:${this.apiToken}`).toString('base64');

    if (this.allowedAccountIds.length > 0) {
      getLog().info({ accountCount: this.allowedAccountIds.length }, 'jira.allowlist_enabled');
    } else {
      getLog().info('jira.allowlist_disabled');
    }

    getLog().info(
      {
        baseUrl: this.baseUrl,
        botMention: this.botMention,
        botAccountIdConfigured: Boolean(this.botAccountId),
        mappedProjectCount: Object.keys(this.projectCodebaseMap).length,
      },
      'jira.adapter_initialized'
    );
  }

  // ---------------------------------------------------------------------------
  // IPlatformAdapter methods
  // ---------------------------------------------------------------------------

  async sendMessage(
    conversationId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    const parsed = this.parseConversationId(conversationId);
    if (!parsed) {
      getLog().error({ conversationId }, 'jira.invalid_conversation_id');
      return;
    }

    getLog().debug({ conversationId, messageLength: message.length }, 'jira.send_message');

    if (message.length <= MAX_LENGTH) {
      await this.postComment(parsed.issueKey, message);
      return;
    }

    getLog().debug({ messageLength: message.length }, 'jira.message_splitting');
    const chunks = splitIntoParagraphChunks(message, MAX_LENGTH - 500);

    for (let i = 0; i < chunks.length; i++) {
      try {
        await this.postComment(parsed.issueKey, chunks[i]);
      } catch (error) {
        const err = error as Error;
        getLog().error(
          { err, chunkIndex: i + 1, totalChunks: chunks.length, conversationId },
          'jira.chunk_post_failed'
        );
        const partialError = new Error(
          `Failed to post comment chunk ${String(i + 1)}/${String(chunks.length)}. ` +
            `${String(i)} chunk(s) were posted before failure.`
        );
        partialError.cause = error;
        throw partialError;
      }
    }
  }

  getStreamingMode(): 'batch' {
    return 'batch';
  }

  getPlatformType(): string {
    return 'jira';
  }

  async start(): Promise<void> {
    getLog().info('jira.webhook_adapter_ready');
  }

  stop(): void {
    getLog().info('jira.adapter_stopped');
  }

  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  // ---------------------------------------------------------------------------
  // Webhook signature verification (HMAC-SHA256, GitHub-style "sha256=..." prefix)
  // ---------------------------------------------------------------------------

  private verifySignature(payload: string, signature: string): boolean {
    try {
      const hmac = createHmac('sha256', this.webhookSecret);
      const digest = 'sha256=' + hmac.update(payload).digest('hex');

      const digestBuffer = Buffer.from(digest);
      const signatureBuffer = Buffer.from(signature);

      if (digestBuffer.length !== signatureBuffer.length) {
        getLog().error(
          { receivedLength: signatureBuffer.length, computedLength: digestBuffer.length },
          'jira.signature_length_mismatch'
        );
        return false;
      }

      const isValid = timingSafeEqual(digestBuffer, signatureBuffer);

      if (!isValid) {
        getLog().error(
          {
            receivedPrefix: signature.substring(0, 15) + '...',
            computedPrefix: digest.substring(0, 15) + '...',
          },
          'jira.signature_mismatch'
        );
      }

      return isValid;
    } catch (error) {
      const err = error as Error;
      getLog().error({ err }, 'jira.signature_verification_error');
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Jira REST API helper
  // ---------------------------------------------------------------------------

  private async jiraApi<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Jira API ${method} ${path}: ${String(response.status)} ${response.statusText} - ${text}`
      );
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  // ---------------------------------------------------------------------------
  // ADF body construction (outbound)
  // ---------------------------------------------------------------------------

  /**
   * Wrap a plain-text message in an ADF document.
   * Each blank-line-separated block becomes a paragraph; the marker is added
   * as a final paragraph so it survives Jira's rendering.
   */
  private toAdfDocument(message: string): AdfDocument {
    const text = `${message}\n\n${BOT_RESPONSE_MARKER}`;
    const paragraphs = text.split(/\n{2,}/).map(para => ({
      type: 'paragraph',
      content: [{ type: 'text', text: para }],
    }));
    return {
      type: 'doc',
      version: 1,
      content: paragraphs,
    };
  }

  // ---------------------------------------------------------------------------
  // Comment posting with retry
  // ---------------------------------------------------------------------------

  private isRetryableError(error: unknown): boolean {
    const err = error as Error | undefined;
    const message = err?.message ?? '';
    const causeErr = (error as { cause?: Error }).cause;
    const cause = causeErr?.message ?? '';
    const combined = `${message} ${cause}`.toLowerCase();

    return (
      combined.includes('timeout') ||
      combined.includes('econnrefused') ||
      combined.includes('econnreset') ||
      combined.includes('etimedout') ||
      combined.includes('fetch failed') ||
      combined.includes('429') ||
      combined.includes('502') ||
      combined.includes('503') ||
      combined.includes('504')
    );
  }

  private async postComment(issueKey: string, message: string): Promise<void> {
    const body = { body: this.toAdfDocument(message) };
    const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.jiraApi('POST', path, body);
        getLog().debug({ issueKey }, 'jira.comment_posted');
        return;
      } catch (error) {
        const isRetryable = this.isRetryableError(error);
        if (attempt < maxRetries && isRetryable) {
          const delay = 1000 * attempt;
          getLog().warn(
            { attempt, maxRetries, issueKey, delayMs: delay },
            'jira.comment_post_retry'
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        getLog().error(
          {
            err: error,
            issueKey,
            attempt,
            maxRetries,
            wasRetryable: isRetryable,
            messageLength: message.length,
          },
          'jira.comment_post_failed'
        );
        throw error;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Conversation ID: issueKey verbatim (e.g. "PROJ-123")
  // ---------------------------------------------------------------------------

  private buildConversationId(issueKey: string): string {
    return issueKey;
  }

  private parseConversationId(conversationId: string): { issueKey: string } | null {
    if (!ISSUE_KEY_PATTERN.test(conversationId)) return null;
    return { issueKey: conversationId };
  }

  private projectKeyFromIssueKey(issueKey: string): string | null {
    const dash = issueKey.lastIndexOf('-');
    if (dash <= 0) return null;
    return issueKey.slice(0, dash);
  }

  // ---------------------------------------------------------------------------
  // Event parsing
  // ---------------------------------------------------------------------------

  private parseEvent(event: JiraWebhookEvent): ParsedEvent | null {
    if (event.webhookEvent === 'comment_created' && event.issue && event.comment) {
      return {
        kind: 'comment_created',
        issue: event.issue,
        body: extractPlainText(event.comment.body),
        authorAccountId: event.comment.author?.accountId,
      };
    }

    if (event.webhookEvent === 'jira:issue_created' && event.issue) {
      return { kind: 'created', issue: event.issue };
    }

    if (event.webhookEvent === 'jira:issue_updated' && event.issue) {
      const items = event.changelog?.items ?? [];
      const statusItem = items.find(i => i.field === 'status');
      if (statusItem) {
        return {
          kind: 'transition',
          issue: event.issue,
          fromStatus: statusItem.fromString ?? '(none)',
          toStatus: statusItem.toString ?? '(none)',
          actor: event.user?.displayName ?? event.user?.accountId,
        };
      }
      const contentItems = items.filter(i => i.field === 'summary' || i.field === 'description');
      if (contentItems.length > 0) {
        return {
          kind: 'content_changed',
          issue: event.issue,
          fields: contentItems.map((i: JiraChangelogItem) => ({
            field: i.field,
            value: i.toString ?? '',
          })),
          actor: event.user?.displayName ?? event.user?.accountId,
        };
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Router payload composition
  // ---------------------------------------------------------------------------

  /**
   * Compose the structured JSON payload handed to the router workflow. The
   * shape is stable and documented — user-authored `jira-router.yaml` depends
   * on the field names here. Only `undefined` event-specific fields are
   * omitted (via JSON.stringify), giving the router a clean, predictable
   * surface to match on.
   */
  private composeRouterPayload(parsed: ParsedEvent, projectKey: string): RouterEventPayload {
    const issue = parsed.issue;
    const base: RouterEventPayload = {
      event: parsed.kind,
      issue_key: issue.key,
      project: projectKey,
      issue_type: issue.fields.issuetype?.name,
      summary: issue.fields.summary,
      status: issue.fields.status?.name,
    };

    switch (parsed.kind) {
      case 'comment_created':
        return {
          ...base,
          comment_body: parsed.body,
          author_account_id: parsed.authorAccountId,
        };
      case 'created':
        return base;
      case 'transition':
        return {
          ...base,
          from_status: parsed.fromStatus,
          to_status: parsed.toStatus,
          actor: parsed.actor,
        };
      case 'content_changed': {
        const first = parsed.fields[0];
        return {
          ...base,
          field: first?.field,
          new_value: first?.value,
          actor: parsed.actor,
        };
      }
    }
  }

  /**
   * Build the slash command the orchestrator will dispatch. The JSON is
   * appended raw — the tokenizer splits it on whitespace, and
   * `handleWorkflowRunCommand` rejoins the pieces with single spaces before
   * handing them to the workflow. See the file header for the full rationale.
   */
  private buildRouterCommand(payload: RouterEventPayload): string {
    const json = JSON.stringify(payload);
    return `/workflow run ${ROUTER_WORKFLOW_NAME} ${json}`;
  }

  // ---------------------------------------------------------------------------
  // Issue context (opaque string passed in MessageMetadata.issueContext)
  // ---------------------------------------------------------------------------

  private buildIssueContext(issue: JiraIssue): string {
    const status = issue.fields.status?.name ?? 'unknown';
    const issueType = issue.fields.issuetype?.name ?? 'unknown';
    const reporter = issue.fields.reporter?.displayName ?? 'unknown';
    return `[Jira Issue Context]
Key: ${issue.key}
Summary: ${issue.fields.summary}
Status: ${status}
Type: ${issueType}
Reporter: ${reporter}`;
  }

  // ---------------------------------------------------------------------------
  // Codebase resolution (explicit YAML mapping)
  // ---------------------------------------------------------------------------

  private async resolveCodebaseForProject(
    projectKey: string
  ): Promise<{ id: string; name: string; default_cwd: string } | null> {
    const codebaseName = this.projectCodebaseMap[projectKey];
    if (!codebaseName) {
      getLog().warn({ projectKey }, 'jira.project_not_mapped');
      return null;
    }
    const codebase = await codebaseDb.findCodebaseByName(codebaseName);
    if (!codebase) {
      getLog().error({ projectKey, codebaseName }, 'jira.mapped_codebase_not_found');
      return null;
    }
    return { id: codebase.id, name: codebase.name, default_cwd: codebase.default_cwd };
  }

  // ---------------------------------------------------------------------------
  // Webhook handler
  // ---------------------------------------------------------------------------

  async handleWebhook(payload: string, signature: string | undefined): Promise<void> {
    // 1. Verify signature
    if (!signature) {
      getLog().error({ payloadSize: payload.length }, 'jira.missing_webhook_signature');
      return;
    }
    if (!this.verifySignature(payload, signature)) {
      getLog().error(
        { signaturePrefix: signature.substring(0, 15) + '...', payloadSize: payload.length },
        'jira.invalid_webhook_signature'
      );
      return;
    }

    // 2. Parse JSON
    let event: JiraWebhookEvent;
    try {
      event = JSON.parse(payload) as JiraWebhookEvent;
    } catch (error) {
      getLog().error({ err: error, payloadSize: payload.length }, 'jira.webhook_parse_failed');
      return;
    }

    // 3. Authorization (accountId allowlist) — fall back to comment author for comment events
    const senderAccountId = event.user?.accountId ?? event.comment?.author?.accountId;
    if (!isJiraUserAuthorized(senderAccountId, this.allowedAccountIds)) {
      const masked = senderAccountId ? `${senderAccountId.slice(0, 4)}***` : 'unknown';
      getLog().info({ maskedAccountId: masked }, 'jira.unauthorized_webhook');
      return;
    }

    // 4. Self-trigger prevention (comments only — bot writes only comments)
    if (event.webhookEvent === 'comment_created' && event.comment) {
      const body = extractPlainText(event.comment.body);
      if (body.includes(BOT_RESPONSE_MARKER)) {
        getLog().debug(
          { commentAuthor: event.comment.author?.accountId },
          'jira.ignoring_marked_comment'
        );
        return;
      }
      if (this.botAccountId && event.comment.author?.accountId === this.botAccountId) {
        getLog().debug(
          { commentAuthor: event.comment.author.accountId },
          'jira.ignoring_own_comment'
        );
        return;
      }
    }

    // 5. Discriminate event
    const parsed = this.parseEvent(event);
    if (!parsed) {
      getLog().debug({ webhookEvent: event.webhookEvent }, 'jira.unhandled_event');
      return;
    }

    const issueKey = parsed.issue.key;
    const projectKey = parsed.issue.fields.project?.key ?? this.projectKeyFromIssueKey(issueKey);
    if (!projectKey) {
      getLog().warn({ issueKey }, 'jira.cannot_resolve_project_key');
      return;
    }

    getLog().info({ eventKind: parsed.kind, issueKey, projectKey }, 'jira.webhook_processing');

    try {
      // 6. Resolve codebase via explicit YAML mapping
      const codebase = await this.resolveCodebaseForProject(projectKey);
      if (!codebase) {
        // Already logged in resolveCodebaseForProject
        return;
      }

      // 7. Conversation setup
      const conversationId = this.buildConversationId(issueKey);
      const existingConv = await db.getOrCreateConversation('jira', conversationId);
      const isNewConversation = !existingConv.codebase_id;

      if (isNewConversation) {
        try {
          await db.updateConversation(existingConv.id, {
            codebase_id: codebase.id,
            cwd: codebase.default_cwd,
          });
        } catch (updateError) {
          if (updateError instanceof ConversationNotFoundError) {
            getLog().error(
              { conversationId: existingConv.id, codebaseId: codebase.id },
              'jira.conversation_codebase_link_failed'
            );
            throw new Error('Failed to set up Jira conversation - please try again');
          }
          throw updateError;
        }
      }

      // 8. Compose router payload and synthesize the slash command.
      const routerPayload = this.composeRouterPayload(parsed, projectKey);
      const command = this.buildRouterCommand(routerPayload);
      const issueContext = this.buildIssueContext(parsed.issue);

      // 9. Dispatch fire-and-forget. No per-ticket locking — workflows own
      //    reconciliation + guarded-transition semantics.
      try {
        await handleMessage(this, conversationId, command, { issueContext });
      } catch (error) {
        const err = toError(error);
        getLog().error(
          { err, conversationId, eventKind: parsed.kind },
          'jira.router_dispatch_failed'
        );
        try {
          const userMessage = classifyAndFormatError(err);
          await this.sendMessage(conversationId, userMessage);
        } catch (sendError) {
          getLog().error(
            { err: toError(sendError), conversationId },
            'jira.error_message_send_failed'
          );
        }
      }
    } catch (error) {
      const err = toError(error);
      const conversationId = this.buildConversationId(issueKey);
      getLog().error({ err, conversationId, issueKey }, 'jira.webhook_setup_failed');
      try {
        const userMessage = classifyAndFormatError(err);
        await this.sendMessage(conversationId, userMessage);
      } catch (sendError) {
        getLog().error(
          { err: toError(sendError), conversationId },
          'jira.webhook_setup_error_send_failed'
        );
      }
    }
  }
}
