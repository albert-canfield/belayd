import { handleToolHook, type HandleDeps } from '../../hook/handle.js';
import type { HookResult } from '../../hook/types.js';
import type { Action, AgentId } from '../../policy/types.js';
import { findWorkspace } from '../../util/paths.js';
import { asRecord } from '../common.js';
import { copilotHooksInstalled } from '../copilot/setup.js';
import type { Answer, Dialect } from '../types.js';

/**
 * The Claude Code hook dialect: snake_case JSON with `hook_event_name`, `tool_name` and
 * `tool_input`, and a `hookSpecificOutput.permissionDecision` answer. Cursor and
 * Copilot CLI also run these hooks from `.claude/settings*.json`, so the payload says
 * which agent is really calling (see `agent`).
 */
export const claudeDialect: Dialect = {
  parse(payload) {
    const event = payload.hook_event_name;
    return {
      phase:
        event === undefined || event === 'PreToolUse'
          ? 'pre'
          : event === 'PostToolUse'
            ? 'post'
            : event === 'PostToolUseFailure'
              ? 'failed'
              : 'other',
      tool: typeof payload.tool_name === 'string' ? payload.tool_name : '',
      input: payload.tool_input ?? {},
      ...strings(payload, { cwd: 'cwd', sessionId: 'session_id', toolUseId: 'tool_use_id' }),
    };
  },
  agent: (payload, env) => detectHost(payload, env),
  // Copilot CLI also runs these hooks. When belayd's own Copilot CLI hooks are installed
  // too, those check the call, and this one stays out of the way.
  handledElsewhere: (agent, event, env) =>
    agent === 'copilot' && copilotHooksInstalled(findWorkspace(event.cwd ?? process.cwd()), env),
  toAction: (tool, input, cwd) => toAction(tool, asRecord(input), cwd),
  workspace: (env) => env.CLAUDE_PROJECT_DIR,
  // Claude Code shows its own prompt in attended sessions. `claude -p` and other
  // unattended runs set CLAUDE_CODE_SESSION_ATTENDED=0 and would auto-deny instead.
  // Cursor does not enforce "ask" from this hook at all, and Copilot CLI only does in
  // interactive sessions, which the hook cannot tell apart.
  canAskNatively: (agent, env) =>
    agent === 'claude-code' && env.CLAUDE_CODE_SESSION_ATTENDED !== '0',
  respond(answer, reason, detail) {
    if (answer === 'pass') return { stdout: '', exitCode: 0 };
    // Copilot CLI reads only a top-level permissionDecision and ignores Claude Code's
    // nested form, so a deny there also exits 2, which it always treats as a deny.
    if (detail.agent === 'copilot') {
      const stdout = JSON.stringify({
        permissionDecision: answer,
        permissionDecisionReason: reason,
      });
      return answer === 'deny'
        ? { stdout, stderr: `${reason}\n`, exitCode: 2 }
        : { stdout, exitCode: 0 };
    }
    return preToolUseDecision(answer, reason);
  },
  sample: (phase, command, cwd) => ({
    hook_event_name: phase === 'pre' ? 'PreToolUse' : 'PostToolUse',
    session_id: 'belayd-sample',
    transcript_path: '/dev/null',
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
  }),
  verdictOf: readPreToolUseDecision,
};

export function handleClaudeCode(raw: string, deps: HandleDeps): Promise<HookResult> {
  return handleToolHook(raw, deps, claudeDialect);
}

/**
 * Agents that run Claude Code's hooks. Cursor says so; Copilot CLI sends an ISO
 * timestamp and no transcript, which Claude Code always sends.
 */
export function detectHost(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): AgentId {
  if (payload.cursor_version || env.CURSOR_VERSION) return 'cursor';
  if (typeof payload.timestamp === 'string' && payload.transcript_path === undefined)
    return 'copilot';
  return 'claude-code';
}

/** The PreToolUse answer shared by Claude Code, Codex and Cursor's compatibility layer. */
export function preToolUseDecision(
  permissionDecision: 'allow' | 'deny' | 'ask',
  reason: string,
): HookResult {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision,
        permissionDecisionReason: reason,
      },
    }),
    exitCode: 0,
  };
}

/** Reads a PreToolUse answer back, as Claude Code and Codex would. */
export function readPreToolUseDecision(result: HookResult): Answer {
  if (result.exitCode === 2) return 'deny';
  if (result.exitCode !== 0 || result.stdout.trim() === '') return 'pass';
  try {
    const out = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string };
      permissionDecision?: string;
    };
    const d = out.hookSpecificOutput?.permissionDecision ?? out.permissionDecision;
    return d === 'allow' || d === 'deny' || d === 'ask' ? d : 'pass';
  } catch {
    return 'pass';
  }
}

/** Copies the string fields of a payload under new names. */
export function strings<K extends string>(
  payload: Record<string, unknown>,
  names: Record<K, string>,
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const [to, from] of Object.entries(names) as [K, string][])
    if (typeof payload[from] === 'string') out[to] = payload[from] as string;
  return out;
}

/** Maps Claude Code tool calls (and Cursor's renamed ones) to belayd actions. */
export function toAction(tool: string, input: Record<string, unknown>, cwd: string): Action {
  const str = (...keys: string[]) => {
    for (const k of keys) if (typeof input[k] === 'string') return input[k] as string;
    return undefined;
  };
  switch (tool) {
    case 'Bash':
    case 'Shell': {
      const command = str('command');
      if (command !== undefined) return { kind: 'shell', command };
      break;
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Delete': {
      const p = str('file_path', 'notebook_path', 'path', 'target_file');
      if (p)
        return {
          kind: 'write',
          path: p,
          ...(typeof input.content === 'string' ? { content: input.content } : {}),
        };
      break;
    }
    case 'Read': {
      const p = str('file_path', 'path', 'target_file');
      if (p) return { kind: 'read', path: p };
      break;
    }
    case 'Glob':
    case 'Grep': {
      // Grep reads the files its `glob` matches. Glob only lists names, so it reads nothing.
      const glob = tool === 'Grep' ? str('glob') : undefined;
      return { kind: 'read', path: str('path') ?? cwd, ...(glob ? { glob } : {}) };
    }
    case 'WebFetch': {
      const url = str('url');
      if (url) return { kind: 'fetch', url };
      break;
    }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool) ?? /^MCP:(.+?)(?::(.+))?$/.exec(tool);
  if (mcp) return { kind: 'mcp', server: mcp[1]!, tool: mcp[2] ?? mcp[1]!, args: input };
  return { kind: 'tool', name: tool, input };
}
