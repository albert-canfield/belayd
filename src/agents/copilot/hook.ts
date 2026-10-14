import type { HookResult } from '../../hook/types.js';
import type { Action } from '../../policy/types.js';
import { parseApplyPatch } from '../codex/patch.js';
import { asRecord } from '../common.js';
import type { Answer, Dialect } from '../types.js';

/**
 * The GitHub Copilot CLI hook dialect (docs.github.com, Copilot CLI hooks reference):
 *
 * - camelCase JSON: `sessionId`, `timestamp`, `cwd`, `toolName`, `toolArgs`, and
 *   `toolResult` after the call. The event is not in the payload, so belayd's hook is
 *   installed with `--event preToolUse` (or postToolUse, postToolUseFailure).
 * - It answers with a top-level `permissionDecision`. Exit 2 and any crash deny.
 * - A timed-out hook lets the tool run, so belayd always answers before the timeout.
 * - `ask` is refused in `copilot -p`, and the hook cannot tell whether a person is
 *   watching, so belayd holds the call and asks the person itself, as for Codex.
 */
export const copilotDialect: Dialect = {
  recognises: (payload) => typeof payload.toolName === 'string',
  parse(payload, event) {
    const e = (event ?? '').toLowerCase();
    const phase =
      e === 'pre' || e === 'pretooluse'
        ? 'pre'
        : e === 'post' || e === 'posttooluse'
          ? 'post'
          : e === 'failed' || e === 'posttoolusefailure'
            ? 'failed'
            : e === ''
              ? payload.toolResult === undefined
                ? 'pre'
                : 'post'
              : 'other';
    return {
      phase,
      tool: typeof payload.toolName === 'string' ? payload.toolName : '',
      input: toolArgs(payload.toolArgs),
      ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
      ...(typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : {}),
      ...(typeof payload.toolCallId === 'string' ? { toolUseId: payload.toolCallId } : {}),
    };
  },
  agent: () => 'copilot',
  toAction: (tool, input, cwd) => toCopilotAction(tool, asRecord(input), cwd),
  canAskNatively: () => false,
  respond(answer: Answer, reason: string): HookResult {
    if (answer === 'pass') return { stdout: '', exitCode: 0 };
    // belayd never leaves a question to Copilot CLI (see above): anything but a yes is a no.
    const decision = answer === 'allow' ? 'allow' : 'deny';
    return {
      stdout: JSON.stringify({ permissionDecision: decision, permissionDecisionReason: reason }),
      exitCode: 0,
    };
  },
  sample: (phase, command, cwd) => ({
    sessionId: 'belayd-sample',
    timestamp: Date.now(),
    cwd,
    toolName: 'bash',
    toolArgs: { command },
    ...(phase === 'post' ? { toolResult: { resultType: 'success', textResultForLlm: '' } } : {}),
  }),
  verdictOf(result) {
    if (result.exitCode !== 0) return 'deny';
    if (result.stdout.trim() === '') return 'pass';
    try {
      const d = (JSON.parse(result.stdout) as { permissionDecision?: string }).permissionDecision;
      return d === 'allow' || d === 'deny' || d === 'ask' ? d : 'pass';
    } catch {
      return 'pass';
    }
  },
};

/** `toolArgs` is an object when Copilot could parse it, and the JSON text otherwise. */
function toolArgs(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? {};
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return { raw: v };
  }
}

/** Maps Copilot CLI's tools to belayd actions. */
export function toCopilotAction(tool: string, input: Record<string, unknown>, cwd: string): Action {
  const str = (...keys: string[]) => {
    for (const k of keys) if (typeof input[k] === 'string') return input[k] as string;
    return undefined;
  };
  switch (tool) {
    case 'bash':
    case 'powershell':
    case 'shell': {
      const command = str('command');
      if (command !== undefined) return { kind: 'shell', command };
      break;
    }
    case 'view': {
      const p = str('path');
      if (p) return { kind: 'read', path: p };
      break;
    }
    case 'create':
    case 'edit':
    case 'str_replace':
    case 'str_replace_editor':
    case 'insert': {
      const p = str('path');
      // str_replace_editor also has a `view` command, which only reads.
      if (p && input.command === 'view') return { kind: 'read', path: p };
      if (p)
        return {
          kind: 'write',
          path: p,
          ...(typeof input.file_text === 'string' ? { content: input.file_text } : {}),
        };
      break;
    }
    case 'apply_patch': {
      const text = str('patch', 'input', 'command', 'raw');
      const files = text ? parseApplyPatch(text) : [];
      if (files.length > 0) return { kind: 'patch', files };
      // A patch belayd cannot read could touch any file. Treat it as code it cannot see.
      return { kind: 'shell', command: '$UNREADABLE_PATCH' };
    }
    case 'grep':
    case 'rg': {
      const glob = str('glob', 'include');
      return { kind: 'read', path: str('path', 'paths') ?? cwd, ...(glob ? { glob } : {}) };
    }
    case 'glob':
      return { kind: 'read', path: str('path') ?? cwd };
    case 'web_fetch': {
      const url = str('url');
      if (url) return { kind: 'fetch', url };
      break;
    }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return { kind: 'mcp', server: mcp[1]!, tool: mcp[2]!, args: input };
  return { kind: 'tool', name: tool, input };
}
