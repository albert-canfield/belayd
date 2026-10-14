import { record, sessionKey, summarizeInput } from '../../audit/record.js';
import type { HookResult } from '../../hook/types.js';
import { actionLabel } from '../../policy/label.js';
import { capture } from '../../snapshots/capture.js';
import { evaluate } from '../../policy/engine.js';
import { loadPolicy } from '../../policy/load.js';
import type { Action, ActionContext, Decision } from '../../policy/types.js';
import { belaydHome, canonicalPath, findWorkspace, homeDir } from '../../util/paths.js';

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
  /** The hook timeout Claude Code was configured with, from `--timeout`. */
  timeoutSec?: number;
  /** Path to belayd's bin.js, used to start the approval page. */
  binPath?: string;
}

/** Older installs used a 30 second hook timeout and did not pass --timeout. */
const DEFAULT_TIMEOUT_SEC = 30;
/** Answer this long before the agent would give up on the hook. */
const SAFETY_MARGIN_MS = 5000;

export async function handleClaudeCode(raw: string, deps: Deps): Promise<HookResult> {
  let input: ClaudeHookInput;
  try {
    input = JSON.parse(raw) as ClaudeHookInput;
  } catch {
    return deny(
      'belayd could not read the hook input from the agent, so it is blocking this action to be safe.',
    );
  }
  const event = input.hook_event_name ?? 'PreToolUse';
  const host = detectHost(input, deps.env);
  const cwd = canonicalPath(input.cwd ?? process.cwd());
  const workspace = deps.env.CLAUDE_PROJECT_DIR
    ? canonicalPath(deps.env.CLAUDE_PROJECT_DIR)
    : findWorkspace(cwd);
  const home = canonicalPath(homeDir(deps.env));
  const stateDir = belaydHome(deps.env);
  const started = Date.now();
  const session = sessionKey(host, input.session_id);

  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    const snapshot = await afterSnapshot(stateDir, input, { cwd, workspace, home, host });
    await record(stateDir, {
      session,
      phase: 'post',
      at: started,
      agent: host,
      workspace,
      cwd,
      tool: input.tool_name,
      toolUseId: input.tool_use_id,
      outcome: event === 'PostToolUseFailure' ? 'failed' : 'ran',
      snapshot,
    });
    return { stdout: '', exitCode: 0 };
  }
  if (event !== 'PreToolUse') return { stdout: '', exitCode: 0 };

  const action = toAction(input.tool_name ?? '', input.tool_input ?? {}, cwd);
  const audit = (
    told: string,
    extra: {
      verdict?: string;
      reason?: string;
      ruleId?: string;
      answeredBy?: string;
      snapshot?: string;
    },
  ) =>
    record(stateDir, {
      session,
      phase: 'pre',
      at: started,
      agent: host,
      workspace,
      cwd,
      tool: input.tool_name,
      toolUseId: input.tool_use_id,
      kind: action.kind,
      label: actionLabel(action),
      input: summarizeInput(input.tool_input ?? {}),
      decision: told,
      durationMs: Date.now() - started,
      ...extra,
    });

  try {
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
    const facts = {
      verdict: decision.verdict,
      reason: decision.reason,
      ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
    };
    if (decision.verdict !== 'ask') {
      const snapshot =
        decision.verdict === 'deny' ? undefined : capture(stateDir, policy, action, ctx);
      await audit(decision.verdict, { ...facts, ...(snapshot ? { snapshot } : {}) });
      return render(decision);
    }

    const timeoutMs = (deps.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
    // Loaded only when a person may need to answer; most tool calls never get here.
    const { resolveAsk } = await import('../../approval/resolve.js');
    const resolution = await resolveAsk({
      decision,
      action,
      ctx,
      policy,
      belaydHome: stateDir,
      env: deps.env,
      deadlineMs: timeoutMs - SAFETY_MARGIN_MS - (Date.now() - started),
      // Claude Code shows its own prompt in attended sessions. `claude -p` and other
      // unattended runs set CLAUDE_CODE_SESSION_ATTENDED=0 and would auto-deny instead.
      // Cursor does not enforce "ask" from this hook at all.
      canAskNatively: host === 'claude-code' && deps.env.CLAUDE_CODE_SESSION_ATTENDED !== '0',
      binPath: deps.binPath ?? process.argv[1] ?? '',
    });
    const snapshot =
      resolution.verdict === 'deny' ? undefined : capture(stateDir, policy, action, ctx);
    await audit(resolution.verdict, {
      ...facts,
      ...(resolution.answeredBy ? { answeredBy: resolution.answeredBy } : {}),
      ...(snapshot ? { snapshot } : {}),
    });
    return output(resolution.verdict, resolution.reason);
  } catch (err) {
    const message = (err as Error).message;
    await audit('deny', { verdict: 'error', reason: `belayd error: ${message}` });
    return deny(
      `belayd hit an error and is blocking this action to be safe: ${message}. ` +
        'Ask the user to run `belayd doctor`.',
    );
  }
}

/** After a tool ran, capture the same scope again so undo knows what the step changed. */
async function afterSnapshot(
  stateDir: string,
  input: ClaudeHookInput,
  where: { cwd: string; workspace: string; home: string; host: Host },
): Promise<string | undefined> {
  try {
    const action = toAction(input.tool_name ?? '', input.tool_input ?? {}, where.cwd);
    const policy = await loadPolicy({ workspace: where.workspace, belaydHome: stateDir });
    return capture(stateDir, policy, action, {
      agent: where.host,
      cwd: where.cwd,
      workspace: where.workspace,
      home: where.home,
    });
  } catch {
    return undefined;
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

function render(decision: Decision): HookResult {
  const rule = decision.ruleId ? ` [rule: ${decision.ruleId}]` : '';
  switch (decision.verdict) {
    case 'pass':
    case 'ask':
      return { stdout: '', exitCode: 0 };
    case 'allow':
      return output('allow', `belayd: ${decision.reason}${rule}`);
    case 'deny':
      return deny(
        `belayd blocked this: ${decision.reason}${rule} ` +
          'Do not try to get around this with a different command. If it is really needed, explain why and let the user decide.',
      );
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
