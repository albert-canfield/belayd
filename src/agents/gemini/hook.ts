import type { HookResult } from '../../hook/types.js';
import type { Action } from '../../policy/types.js';
import { strings } from '../claude-code/hook.js';
import { asRecord, shellQuote } from '../common.js';
import type { Answer, Dialect } from '../types.js';

/**
 * The Gemini CLI hook dialect (geminicli.com, hooks reference; tool names from the
 * 0.64 source):
 *
 * - snake_case JSON like Claude Code's: `hook_event_name` is `BeforeTool` or
 *   `AfterTool`, with `tool_name`, `tool_input`, `cwd` and `session_id`. No call id.
 * - It answers with `{ "decision": "allow" | "deny", "reason": "..." }`. Exit 2 blocks;
 *   any other failure only warns and lets the tool run, so the installed command turns
 *   a crash into exit 2.
 * - A hook cannot ask, so belayd holds the call and asks the person itself.
 */
export const GEMINI_EVENTS = new Set(['BeforeTool', 'AfterTool']);

export const geminiDialect: Dialect = {
  recognises: (payload) => GEMINI_EVENTS.has(String(payload.hook_event_name)),
  parse(payload) {
    const event = payload.hook_event_name;
    const response = asRecord(payload.tool_response);
    return {
      phase:
        event === 'BeforeTool'
          ? 'pre'
          : event === 'AfterTool'
            ? response.error === undefined
              ? 'post'
              : 'failed'
            : 'other',
      tool: typeof payload.tool_name === 'string' ? payload.tool_name : '',
      input: payload.tool_input ?? {},
      ...strings(payload, { cwd: 'cwd', sessionId: 'session_id' }),
    };
  },
  agent: () => 'gemini',
  toAction: (tool, input, cwd) => toGeminiAction(tool, asRecord(input), cwd),
  workspace: (env) => env.GEMINI_PROJECT_DIR,
  canAskNatively: () => false,
  respond(answer: Answer, reason: string): HookResult {
    if (answer === 'pass') return { stdout: '', exitCode: 0 };
    // Gemini CLI hooks cannot ask, and belayd resolves questions before answering:
    // anything but a yes is a no.
    const decision = answer === 'allow' ? 'allow' : 'deny';
    return { stdout: JSON.stringify({ decision, reason }), exitCode: 0 };
  },
  sample: (phase, command, cwd) => ({
    hook_event_name: phase === 'pre' ? 'BeforeTool' : 'AfterTool',
    session_id: 'belayd-sample',
    transcript_path: '',
    timestamp: new Date().toISOString(),
    cwd,
    tool_name: 'run_shell_command',
    tool_input: { command },
    ...(phase === 'post' ? { tool_response: { llmContent: '' } } : {}),
  }),
  verdictOf(result) {
    if (result.exitCode === 2) return 'deny';
    if (result.stdout.trim() === '') return 'pass';
    try {
      const d = (JSON.parse(result.stdout) as { decision?: string }).decision;
      return d === 'deny' || d === 'block' ? 'deny' : d === 'allow' ? 'allow' : 'pass';
    } catch {
      return 'pass';
    }
  },
};

/** Maps Gemini CLI's built-in tools (and MCP tools) to belayd actions. */
export function toGeminiAction(tool: string, input: Record<string, unknown>, cwd: string): Action {
  const str = (key: string) =>
    typeof input[key] === 'string' ? (input[key] as string) : undefined;
  const list = (key: string) => {
    const v = input[key];
    if (typeof v === 'string') return [v];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  };
  switch (tool) {
    case 'run_shell_command': {
      const command = str('command');
      const dir = str('dir_path');
      // The command runs in dir_path when it is given.
      if (command !== undefined)
        return { kind: 'shell', command: dir ? `cd ${shellQuote(dir)} && ${command}` : command };
      break;
    }
    case 'read_file': {
      const p = str('file_path') ?? str('absolute_path');
      if (p) return { kind: 'read', path: p };
      break;
    }
    case 'read_many_files': {
      // Glob patterns relative to the project; any one of them may reach a secret file.
      const patterns = [...list('include'), ...list('paths')];
      if (patterns.length > 0)
        return {
          kind: 'read',
          path: cwd,
          glob: patterns.length === 1 ? patterns[0]! : `{${patterns.join(',')}}`,
        };
      break;
    }
    case 'write_file':
    case 'replace': {
      const p = str('file_path');
      if (p)
        return {
          kind: 'write',
          path: p,
          ...(tool === 'write_file' && typeof input.content === 'string'
            ? { content: input.content }
            : {}),
        };
      break;
    }
    case 'grep_search':
    case 'search_file_content': {
      const glob = str('include_pattern') ?? str('include');
      return {
        kind: 'read',
        path: str('dir_path') ?? str('path') ?? cwd,
        ...(glob ? { glob } : {}),
      };
    }
    case 'glob':
    case 'list_directory':
      // Lists names only, like Claude Code's Glob.
      return { kind: 'read', path: str('dir_path') ?? str('path') ?? cwd };
    case 'web_fetch': {
      // The URLs are inside a free-text prompt.
      const url = /https?:\/\/[^\s"'<>)]+/.exec(str('prompt') ?? '')?.[0];
      if (url) return { kind: 'fetch', url };
      break;
    }
  }
  const mcp = /^mcp_([^_]+)_(.+)$/.exec(tool);
  if (mcp) return { kind: 'mcp', server: mcp[1]!, tool: mcp[2]!, args: input };
  return { kind: 'tool', name: tool, input };
}
