import path from 'node:path';
import type { HookResult } from '../../hook/types.js';
import { evaluate } from '../../policy/engine.js';
import { loadPolicy } from '../../policy/load.js';
import type { Action, ActionContext, Decision } from '../../policy/types.js';
import { belaydHome, findWorkspace, homeDir } from '../../util/paths.js';

/** The fields belayd reads from a Claude Code hook payload. */
export interface ClaudeHookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  permission_mode?: string;
  /** Present when Cursor runs this hook through its Claude Code compatibility layer. */
  cursor_version?: string;
}

/** Agents that load Claude Code hooks from `.claude/settings*.json`. */
export type Host = 'claude-code' | 'cursor';

interface Deps {
  env: NodeJS.ProcessEnv;
}

export async function handleClaudeCode(raw: string, deps: Deps): Promise<HookResult> {
  let input: ClaudeHookInput;
  try {
    input = JSON.parse(raw) as ClaudeHookInput;
  } catch {
    return deny(
      'belayd could not read the hook input from the agent, so it is blocking this action to be safe.',
    );
  }
  if (input.hook_event_name && input.hook_event_name !== 'PreToolUse')
    return { stdout: '', exitCode: 0 };

  const host = detectHost(input, deps.env);
  const cwd = input.cwd ? path.resolve(input.cwd) : process.cwd();
  const workspace = deps.env.CLAUDE_PROJECT_DIR
    ? path.resolve(deps.env.CLAUDE_PROJECT_DIR)
    : findWorkspace(cwd);
  const home = homeDir(deps.env);
  const stateDir = belaydHome(deps.env);

  try {
    const action = toAction(input.tool_name ?? '', input.tool_input ?? {}, cwd);
    const ctx: ActionContext = {
      agent: host,
      ...(input.tool_name ? { toolName: input.tool_name } : {}),
      ...(input.session_id ? { sessionId: input.session_id } : {}),
      ...(input.tool_use_id ? { toolUseId: input.tool_use_id } : {}),
      cwd,
      workspace,
      home,
    };
    const policy = await loadPolicy({ workspace, belaydHome: stateDir });
    const decision = evaluate(action, ctx, policy, { belaydHome: stateDir });
    return render(decision, host);
  } catch (err) {
    return deny(
      `belayd hit an error and is blocking this action to be safe: ${(err as Error).message}. ` +
        'Ask the user to run `belayd doctor`.',
    );
  }
}

export function detectHost(input: ClaudeHookInput, env: NodeJS.ProcessEnv): Host {
  if (input.cursor_version || env.CURSOR_VERSION) return 'cursor';
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
    case 'Grep':
      return { kind: 'read', path: str('path') ?? cwd };
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

function render(decision: Decision, host: Host): HookResult {
  const rule = decision.ruleId ? ` [rule: ${decision.ruleId}]` : '';
  switch (decision.verdict) {
    case 'pass':
      return { stdout: '', exitCode: 0 };
    case 'allow':
      return output('allow', `belayd: ${decision.reason}${rule}`);
    case 'deny':
      return deny(
        `belayd blocked this: ${decision.reason}${rule} ` +
          'Do not try to get around this with a different command. If it is really needed, explain why and let the user decide.',
      );
    case 'ask':
      if (host === 'cursor') {
        // Cursor does not enforce "ask" from preToolUse hooks; returning it would let the call run.
        return deny(
          `belayd needs a person to approve this, and Cursor cannot ask from this hook yet: ${decision.reason}${rule} ` +
            'Ask the user to run it themselves, or to allow it in belayd.yaml.',
        );
      }
      return output('ask', `belayd: ${decision.reason}${rule}`);
  }
}

function deny(reason: string): HookResult {
  return output('deny', reason);
}

function output(permissionDecision: 'allow' | 'deny' | 'ask', reason: string): HookResult {
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
