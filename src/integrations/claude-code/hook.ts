import {
  handleToolHook,
  preToolUseDecision,
  type Dialect,
  type HandleDeps,
  type HookInput,
} from '../../hook/handle.js';
import type { HookResult } from '../../hook/types.js';
import type { Action } from '../../policy/types.js';

export type ClaudeHookInput = HookInput;

/** Agents that load Claude Code hooks from `.claude/settings*.json`. */
export type Host = 'claude-code' | 'cursor' | 'copilot';

export const claudeDialect: Dialect = {
  agent: (input, env) => detectHost(input, env),
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
};

export function handleClaudeCode(raw: string, deps: HandleDeps): Promise<HookResult> {
  return handleToolHook(raw, deps, claudeDialect);
}

export function detectHost(input: HookInput, env: NodeJS.ProcessEnv): Host {
  if (input.cursor_version || env.CURSOR_VERSION) return 'cursor';
  // Copilot CLI runs `.claude/settings*.json` hooks with a payload that has an ISO
  // timestamp and no transcript, which Claude Code always sends.
  if (typeof input.timestamp === 'string' && input.transcript_path === undefined) return 'copilot';
  return 'claude-code';
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

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
