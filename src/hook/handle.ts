import { record, sessionKey, summarizeInput } from '../audit/record.js';
import { addSessionWrites, sessionWrites } from '../audit/session.js';
import { buildSubjects } from '../policy/subjects.js';
import { evaluate } from '../policy/engine.js';
import { actionLabel } from '../policy/label.js';
import { loadPolicy } from '../policy/load.js';
import type { Action, ActionContext, AgentId } from '../policy/types.js';
import { capture } from '../snapshots/capture.js';
import { belaydHome, canonicalPath, findWorkspace, homeDir } from '../util/paths.js';
import type { HookResult } from './types.js';

/** The fields belayd reads from a hook payload. Claude Code, Codex and Cursor all send these. */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  permission_mode?: string;
  /** Present when Cursor runs a Claude Code hook through its compatibility layer. */
  cursor_version?: string;
}

/** What belayd finally tells the agent. */
export type Answer = 'allow' | 'ask' | 'deny' | 'pass';

/** How one agent speaks the hook protocol. */
export interface Dialect {
  /** The agent that sent this payload. */
  agent(input: HookInput, env: NodeJS.ProcessEnv): AgentId;
  toAction(tool: string, input: unknown, cwd: string): Action;
  /** The project root, when the agent tells us. */
  workspace?(env: NodeJS.ProcessEnv): string | undefined;
  /** Whether answering `ask` makes the agent show its own prompt. */
  canAskNatively(agent: AgentId, env: NodeJS.ProcessEnv): boolean;
  /** Turns belayd's answer into what this agent expects on stdout. */
  respond(answer: Answer, reason: string, detail: { approvedBy?: string }): HookResult;
}

export interface HandleDeps {
  env: NodeJS.ProcessEnv;
  /** The hook timeout the agent was configured with, from `--timeout`. */
  timeoutSec?: number;
  /** Path to belayd's bin.js, used to start the approval page. */
  binPath?: string;
}

/** Older installs used a 30 second hook timeout and did not pass --timeout. */
const DEFAULT_TIMEOUT_SEC = 30;
/** Answer this long before the agent would give up on the hook. */
const SAFETY_MARGIN_MS = 5000;

export async function handleToolHook(
  raw: string,
  deps: HandleDeps,
  dialect: Dialect,
): Promise<HookResult> {
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    return dialect.respond(
      'deny',
      'belayd could not read the hook input from the agent, so it is blocking this action to be safe.',
      {},
    );
  }
  const event = input.hook_event_name ?? 'PreToolUse';
  const agent = dialect.agent(input, deps.env);
  const cwd = canonicalPath(input.cwd ?? process.cwd());
  const declared = dialect.workspace?.(deps.env);
  const workspace = declared ? canonicalPath(declared) : findWorkspace(cwd);
  const home = canonicalPath(homeDir(deps.env));
  const stateDir = belaydHome(deps.env);
  const started = Date.now();
  const session = sessionKey(agent, input.session_id);
  const ctxBase: ActionContext = { agent, cwd, workspace, home };

  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    let snapshot: string | undefined;
    try {
      const action = dialect.toAction(input.tool_name ?? '', input.tool_input ?? {}, cwd);
      const policy = await loadPolicy({ workspace, belaydHome: stateDir });
      snapshot = capture(stateDir, policy, action, ctxBase);
      addSessionWrites(
        stateDir,
        session,
        buildSubjects(action, ctxBase).flatMap((s) => s.writes),
      );
    } catch {
      // recording the outcome matters more than the snapshot
    }
    await record(stateDir, {
      session,
      phase: 'post',
      at: started,
      agent,
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

  const action = dialect.toAction(input.tool_name ?? '', input.tool_input ?? {}, cwd);
  const audit = (
    told: Answer,
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
      agent,
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

  let failMode: 'open' | 'closed' = 'closed';
  try {
    const ctx: ActionContext = {
      ...ctxBase,
      ...(input.tool_name ? { toolName: input.tool_name } : {}),
      ...(input.session_id ? { sessionId: input.session_id } : {}),
      ...(input.tool_use_id ? { toolUseId: input.tool_use_id } : {}),
    };
    const policy = await loadPolicy({ workspace, belaydHome: stateDir });
    failMode = policy.failMode;
    // Fault injection for the test suite, which proves that failures block.
    if (deps.env.BELAYD_FAULT === 'after-policy') throw new Error('injected fault');
    const decision = evaluate(action, ctx, policy, {
      belaydHome: stateDir,
      sessionWrites: sessionWrites(stateDir, session),
    });
    const rule = decision.ruleId ? ` [rule: ${decision.ruleId}]` : '';
    const facts = {
      verdict: decision.verdict,
      reason: decision.reason,
      ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
    };

    if (decision.verdict !== 'ask') {
      const snapshot =
        decision.verdict === 'deny' ? undefined : capture(stateDir, policy, action, ctx);
      await audit(decision.verdict, { ...facts, ...(snapshot ? { snapshot } : {}) });
      if (decision.verdict === 'deny') {
        return dialect.respond('deny', blocked(decision.reason, rule), {});
      }
      return dialect.respond(decision.verdict, `belayd: ${decision.reason}${rule}`, {});
    }

    const timeoutMs = (deps.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
    // Loaded only when a person may need to answer; most tool calls never get here.
    const { resolveAsk } = await import('../approval/resolve.js');
    const resolution = await resolveAsk({
      decision,
      action,
      ctx,
      policy,
      belaydHome: stateDir,
      env: deps.env,
      deadlineMs: timeoutMs - SAFETY_MARGIN_MS - (Date.now() - started),
      canAskNatively: dialect.canAskNatively(agent, deps.env),
      binPath: deps.binPath ?? process.argv[1] ?? '',
    });
    const snapshot =
      resolution.verdict === 'deny' ? undefined : capture(stateDir, policy, action, ctx);
    await audit(resolution.verdict, {
      ...facts,
      ...(resolution.answeredBy ? { answeredBy: resolution.answeredBy } : {}),
      ...(snapshot ? { snapshot } : {}),
    });
    return dialect.respond(resolution.verdict, resolution.reason, {
      ...(resolution.answeredBy ? { approvedBy: resolution.answeredBy } : {}),
    });
  } catch (err) {
    const message = (err as Error).message;
    if (failMode === 'open') {
      // The user chose to let the agent continue when belayd itself breaks. Logged every time.
      await audit('pass', {
        verdict: 'error',
        reason: `belayd error (failMode: open): ${message}`,
      });
      return dialect.respond(
        'pass',
        `belayd error, continuing because failMode is open: ${message}`,
        {},
      );
    }
    await audit('deny', { verdict: 'error', reason: `belayd error: ${message}` });
    return dialect.respond(
      'deny',
      `belayd hit an error and is blocking this action to be safe: ${message}. ` +
        'Ask the user to run `belayd doctor`.',
      {},
    );
  }
}

function blocked(reason: string, rule: string): string {
  return (
    `belayd blocked this: ${reason}${rule} ` +
    'Do not try to get around this with a different command. If it is really needed, explain why and let the user decide.'
  );
}

/** The PreToolUse output shape shared by Claude Code, Codex and Cursor's compatibility layer. */
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
