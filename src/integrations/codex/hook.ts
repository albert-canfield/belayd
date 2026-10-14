import {
  handleToolHook,
  preToolUseDecision,
  type Dialect,
  type HandleDeps,
} from '../../hook/handle.js';
import type { HookResult } from '../../hook/types.js';
import type { Action } from '../../policy/types.js';
import { asRecord } from '../claude-code/hook.js';
import { parseApplyPatch } from './patch.js';

/**
 * Codex speaks almost the same hook dialect as Claude Code, with two differences
 * that matter for safety:
 *
 * - It cannot ask. A PreToolUse hook that answers "ask" is treated as a failed hook
 *   and the tool runs anyway. belayd therefore holds the call and asks the person
 *   itself (`belayd approve` or the web page), then answers allow or deny.
 * - "allow" is only documented together with a rewritten input, so an approval is
 *   returned as no decision plus a systemMessage; Codex then continues normally.
 */
export const codexDialect: Dialect = {
  agent: () => 'codex',
  toAction: (tool, input) => toCodexAction(tool, input),
  canAskNatively: () => false,
  respond(answer, reason, detail): HookResult {
    // Codex would treat "ask" as a failed hook and run the tool, so it can only ever be a no.
    if (answer === 'deny' || answer === 'ask') return preToolUseDecision('deny', reason);
    if (detail.approvedBy)
      return { stdout: JSON.stringify({ systemMessage: reason }), exitCode: 0 };
    return { stdout: '', exitCode: 0 };
  },
};

export function handleCodex(raw: string, deps: HandleDeps): Promise<HookResult> {
  return handleToolHook(raw, deps, codexDialect);
}

export function toCodexAction(tool: string, raw: unknown): Action {
  const input = asRecord(raw);
  const command = commandText(input.command);
  if (tool === 'Bash' && command !== undefined) return { kind: 'shell', command };
  if (tool === 'apply_patch' && command !== undefined) {
    const files = parseApplyPatch(command);
    if (files.length > 0) return { kind: 'patch', files };
    // A patch belayd cannot read could touch any file. Treat it as code it cannot see.
    return { kind: 'shell', command: '$UNREADABLE_PATCH' };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return { kind: 'mcp', server: mcp[1]!, tool: mcp[2]!, args: input };
  return { kind: 'tool', name: tool, input };
}

/** Codex usually sends a string; an argv array is joined with shell quoting. */
function commandText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
    return v
      .map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
      .join(' ');
  }
  return undefined;
}
