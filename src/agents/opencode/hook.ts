import type { HookResult } from '../../hook/types.js';
import type { Action } from '../../policy/types.js';
import { parseApplyPatch } from '../codex/patch.js';
import { asRecord, shellQuote } from '../common.js';
import type { Answer, Dialect } from '../types.js';

/**
 * OpenCode has no command hooks. It runs JavaScript plugins, so belayd installs a small
 * one (see setup.ts) whose `tool.execute.before` and `tool.execute.after` hooks send
 * each call here as JSON and wait for the answer. Facts from the 1.19 source:
 *
 * - `before` gets `{ tool, sessionID, callID }` and `{ args }`. Throwing blocks the call
 *   and the error message is what the model sees. There is no timeout, so the plugin
 *   can wait while belayd asks the person.
 * - `after` gets the same plus `args`. It does not run when the tool failed.
 * - A plugin cannot raise OpenCode's own permission prompt, so belayd holds the call
 *   and asks the person itself, as for Codex.
 */
export const OPENCODE_MARK = 'belayd-opencode-plugin';

export const opencodeDialect: Dialect = {
  recognises: (payload) => payload.source === OPENCODE_MARK,
  parse(payload) {
    const event = payload.event;
    return {
      phase: event === 'before' ? 'pre' : event === 'after' ? 'post' : 'other',
      tool: typeof payload.tool === 'string' ? payload.tool : '',
      input: payload.args ?? {},
      ...(typeof payload.directory === 'string' ? { cwd: payload.directory } : {}),
      ...(typeof payload.sessionID === 'string' ? { sessionId: payload.sessionID } : {}),
      ...(typeof payload.callID === 'string' ? { toolUseId: payload.callID } : {}),
    };
  },
  agent: () => 'opencode',
  toAction: (tool, input, cwd) => toOpencodeAction(tool, asRecord(input), cwd),
  canAskNatively: () => false,
  respond(answer: Answer, reason: string): HookResult {
    if (answer === 'pass') return { stdout: '', exitCode: 0 };
    // belayd resolves questions before answering: anything but a yes is a no.
    const decision = answer === 'allow' ? 'allow' : 'deny';
    return { stdout: JSON.stringify({ decision, reason }), exitCode: 0 };
  },
  sample: (phase, command, cwd) => ({
    source: OPENCODE_MARK,
    event: phase === 'pre' ? 'before' : 'after',
    tool: 'bash',
    sessionID: 'belayd-sample',
    callID: `belayd-sample-${phase}`,
    directory: cwd,
    args: { command, description: 'belayd sample' },
  }),
  verdictOf(result) {
    if (result.exitCode !== 0) return 'deny';
    if (result.stdout.trim() === '') return 'pass';
    try {
      const d = (JSON.parse(result.stdout) as { decision?: string }).decision;
      return d === 'deny' ? 'deny' : d === 'allow' ? 'allow' : 'pass';
    } catch {
      return 'deny';
    }
  },
};

/** OpenCode's own tools, which never contain an underscore except apply_patch. */
const BUILT_IN = new Set([
  'bash',
  'read',
  'write',
  'edit',
  'apply_patch',
  'glob',
  'grep',
  'list',
  'webfetch',
  'websearch',
  'task',
  'todowrite',
  'todoread',
  'skill',
  'question',
  'lsp',
  'plan_exit',
  'invalid',
]);

/** Maps OpenCode's built-in tools (and MCP tools) to belayd actions. */
export function toOpencodeAction(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): Action {
  const str = (key: string) =>
    typeof input[key] === 'string' ? (input[key] as string) : undefined;
  switch (tool) {
    case 'bash': {
      const command = str('command');
      const dir = str('workdir');
      // The command runs in workdir when it is given.
      if (command !== undefined)
        return { kind: 'shell', command: dir ? `cd ${shellQuote(dir)} && ${command}` : command };
      break;
    }
    case 'read': {
      const p = str('filePath');
      if (p) return { kind: 'read', path: p };
      break;
    }
    case 'write':
    case 'edit': {
      const p = str('filePath');
      if (p)
        return {
          kind: 'write',
          path: p,
          ...(tool === 'write' && typeof input.content === 'string'
            ? { content: input.content }
            : {}),
        };
      break;
    }
    case 'apply_patch': {
      const files = parseApplyPatch(str('patchText') ?? '');
      if (files.length > 0) return { kind: 'patch', files };
      // A patch belayd cannot read could touch any file: code it cannot see, as for Codex.
      return { kind: 'shell', command: '$UNREADABLE_PATCH' };
    }
    case 'grep': {
      const glob = str('include');
      return { kind: 'read', path: str('path') ?? cwd, ...(glob ? { glob } : {}) };
    }
    case 'glob':
    case 'list':
      // Lists names only, like Claude Code's Glob.
      return { kind: 'read', path: str('path') ?? cwd };
    case 'webfetch': {
      const url = str('url');
      if (url) return { kind: 'fetch', url };
      break;
    }
  }
  // MCP tools are named `<server>_<tool>`, with both parts cleaned to [A-Za-z0-9_-].
  if (!BUILT_IN.has(tool)) {
    const cut = tool.indexOf('_');
    if (cut > 0)
      return { kind: 'mcp', server: tool.slice(0, cut), tool: tool.slice(cut + 1), args: input };
  }
  return { kind: 'tool', name: tool, input };
}
