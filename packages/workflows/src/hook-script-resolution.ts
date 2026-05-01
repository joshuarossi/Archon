/**
 * Resolve workflow hook `script` matchers to concrete filesystem paths for execution.
 * - Inline scripts are materialized under the OS temp directory.
 * - Named scripts and explicit paths are resolved via resolveHookScriptMatcher.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';

import type { WorkflowNodeHooks, WorkflowHookMatcher } from './schemas';
import type { ScriptRuntime } from './script-discovery';
import { discoverScriptsForCwd } from './script-discovery';
import { isInlineScript } from './executor-shared';

export type ResolvedHookScript =
  | { kind: 'inline'; body: string; runtime: ScriptRuntime }
  | { kind: 'file'; path: string; runtime: ScriptRuntime };

/**
 * Resolve a hook `script` field to either inline body or an on-disk file path.
 * @throws If the script cannot be found or runtime conflicts with file type.
 */
export async function resolveHookScriptMatcher(
  script: string,
  runtime: ScriptRuntime | undefined,
  cwd: string
): Promise<ResolvedHookScript> {
  if (isInlineScript(script)) {
    return { kind: 'inline', body: script, runtime: runtime ?? 'bun' };
  }

  const candidate = isAbsolute(script) ? script : resolve(cwd, script);
  try {
    const s = await stat(candidate);
    if (s.isFile()) {
      const detected: ScriptRuntime = candidate.endsWith('.py') ? 'uv' : 'bun';
      if (runtime !== undefined && runtime !== detected) {
        throw new Error(
          `Hook script runtime '${runtime}' does not match file type for '${candidate}' (expected '${detected}')`
        );
      }
      return { kind: 'file', path: candidate, runtime: runtime ?? detected };
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  const scripts = await discoverScriptsForCwd(cwd);
  const entry = scripts.get(script);
  if (!entry) {
    throw new Error(
      `Hook script '${script}' not found: no file at '${candidate}' and no named script in .archon/scripts or ~/.archon/scripts`
    );
  }
  if (runtime !== undefined && runtime !== entry.runtime) {
    throw new Error(
      `Hook script '${script}' is registered as ${entry.runtime} but workflow specifies runtime: ${runtime}`
    );
  }
  return { kind: 'file', path: entry.path, runtime: runtime ?? entry.runtime };
}

function materializeInlineHookScript(body: string, runtime: ScriptRuntime): string {
  const dir = join(tmpdir(), `archon-hook-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  const ext = runtime === 'uv' ? 'py' : 'ts';
  const fp = join(dir, `hook.${ext}`);
  writeFileSync(fp, body, 'utf8');
  return fp;
}

/**
 * Walk all hook matchers and resolve `script` entries to absolute file paths
 * (materializing inline scripts to temp files). Static `response` matchers are unchanged.
 */
export async function resolveWorkflowHooksForExecution(
  hooks: WorkflowNodeHooks,
  cwd: string
): Promise<WorkflowNodeHooks> {
  const out: Record<string, WorkflowHookMatcher[]> = {};

  for (const [event, matchers] of Object.entries(hooks)) {
    if (!matchers?.length) continue;
    const resolvedList: WorkflowHookMatcher[] = [];
    for (const m of matchers) {
      if (m.response !== undefined) {
        resolvedList.push(m);
        continue;
      }
      if (m.script === undefined) {
        throw new Error('hook matcher: internal error — neither response nor script');
      }
      const r = await resolveHookScriptMatcher(m.script, m.runtime, cwd);
      if (r.kind === 'inline') {
        const path = materializeInlineHookScript(r.body, r.runtime);
        resolvedList.push({
          ...m,
          script: path,
          runtime: r.runtime,
        });
      } else {
        resolvedList.push({
          ...m,
          script: r.path,
          runtime: r.runtime,
        });
      }
    }
    out[event] = resolvedList;
  }

  return out as WorkflowNodeHooks;
}
