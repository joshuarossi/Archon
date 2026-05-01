/**
 * Zod schemas for per-node hook configuration.
 */
import { z } from '@hono/zod-openapi';

/**
 * Supported hook events for per-node hooks.
 * Uses the same event names as the Claude Agent SDK's HookEvent type.
 */
export const workflowHookEventSchema = z.enum([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PermissionRequest',
  'Setup',
  'TeammateIdle',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
]);

export type WorkflowHookEvent = z.infer<typeof workflowHookEventSchema>;

/** Canonical list of hook events — derived from schema, do not duplicate. */
export const WORKFLOW_HOOK_EVENTS: readonly WorkflowHookEvent[] = workflowHookEventSchema.options;

const hookRuntimeSchema = z.enum(['bun', 'uv']);

/**
 * A single hook matcher in a YAML workflow definition.
 * Maps to the SDK's HookCallbackMatcher.
 *
 * Exactly one of:
 * - **Static**: `response` — same object returned on every hook invocation (legacy).
 * - **Script**: `script` — Bun or uv subprocess; stdin receives JSON hook input; stdout is SyncHookJSONOutput (empty stdout = allow passthrough).
 */
export const workflowHookMatcherSchema = z
  .object({
    /** Regex pattern to match tool names (PreToolUse/PostToolUse) or event subtypes. */
    matcher: z.string().optional(),
    /** Timeout in seconds (default: SDK default of 60). Enforced for script hooks. */
    timeout: z.number().positive().optional(),
    /** Static SDK output — mutually exclusive with `script`. */
    response: z.record(z.unknown()).optional(),
    /** Named script key, filesystem path, or inline source — mutually exclusive with `response`. */
    script: z.string().min(1, 'script cannot be empty').optional(),
    /** Runtime for `script` hooks. Default `bun`. For named scripts, discovery may override when omitted. */
    runtime: hookRuntimeSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasResponse = data.response !== undefined;
    const hasScript = data.script !== undefined;
    if (hasResponse === hasScript) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: hasResponse
          ? 'hook matcher cannot set both response and script — use exactly one'
          : 'hook matcher must set either response (static) or script (dynamic subprocess)',
      });
    }
  });

export type WorkflowHookMatcher = z.infer<typeof workflowHookMatcherSchema>;

/**
 * Per-node hook configuration keyed by event name.
 * Each event maps to an array of matchers with static responses.
 *
 * Fields are listed explicitly (not z.record) so TypeScript narrows event names
 * to the WorkflowHookEvent union. `.strict()` rejects unknown keys, producing
 * clear validation errors for typos like 'preToolUse'.
 */
export const workflowNodeHooksSchema = z
  .object({
    PreToolUse: z.array(workflowHookMatcherSchema).optional(),
    PostToolUse: z.array(workflowHookMatcherSchema).optional(),
    PostToolUseFailure: z.array(workflowHookMatcherSchema).optional(),
    Notification: z.array(workflowHookMatcherSchema).optional(),
    UserPromptSubmit: z.array(workflowHookMatcherSchema).optional(),
    SessionStart: z.array(workflowHookMatcherSchema).optional(),
    SessionEnd: z.array(workflowHookMatcherSchema).optional(),
    Stop: z.array(workflowHookMatcherSchema).optional(),
    SubagentStart: z.array(workflowHookMatcherSchema).optional(),
    SubagentStop: z.array(workflowHookMatcherSchema).optional(),
    PreCompact: z.array(workflowHookMatcherSchema).optional(),
    PermissionRequest: z.array(workflowHookMatcherSchema).optional(),
    Setup: z.array(workflowHookMatcherSchema).optional(),
    TeammateIdle: z.array(workflowHookMatcherSchema).optional(),
    TaskCompleted: z.array(workflowHookMatcherSchema).optional(),
    Elicitation: z.array(workflowHookMatcherSchema).optional(),
    ElicitationResult: z.array(workflowHookMatcherSchema).optional(),
    ConfigChange: z.array(workflowHookMatcherSchema).optional(),
    WorktreeCreate: z.array(workflowHookMatcherSchema).optional(),
    WorktreeRemove: z.array(workflowHookMatcherSchema).optional(),
    InstructionsLoaded: z.array(workflowHookMatcherSchema).optional(),
  })
  .strict();

export type WorkflowNodeHooks = z.infer<typeof workflowNodeHooksSchema>;
