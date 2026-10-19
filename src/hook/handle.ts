import path from 'node:path';
import { record, sessionKey, summarizeInput } from '../audit/record.js';
import { addSessionWrites, finishCall, sessionWrites, startCall } from '../audit/session.js';
import { buildSubjects } from '../policy/subjects.js';
import { evaluate } from '../policy/engine.js';
import { actionLabel } from '../policy/label.js';
import { loadPolicy } from '../policy/load.js';
import type { Answer, Dialect } from '../agents/types.js';
import type { ActionContext } from '../policy/types.js';
import { capture } from '../snapshots/capture.js';
import { belaydHome, canonicalPath, findWorkspace, homeDir } from '../util/paths.js';
import type { HookResult } from './types.js';
import { startWatchdog } from './watchdog.js';

export interface HandleDeps {
  env: NodeJS.ProcessEnv;
  /** The hook timeout the agent was configured with, from `--timeout`. */
  timeoutSec?: number;
  /** Path to belayd's bin.js, used to start the approval page. */
  binPath?: string;
  /** The `--event` the hook was installed with, for agents whose payload does not say. */
  event?: string;
}

/** Older installs used a 30 second hook timeout and did not pass --timeout. */
const DEFAULT_TIMEOUT_SEC = 30;
/** Answer this long before the agent would give up on the hook. */
const SAFETY_MARGIN_MS = 5000;
/** Checking a call takes milliseconds. Past this, something is stuck and the call is blocked. */
const CHECK_DEADLINE_MS = 20_000;

export async function handleToolHook(
  raw: string,
  deps: HandleDeps,
  dialect: Dialect,
): Promise<HookResult> {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    payload = parsed as Record<string, unknown>;
  } catch {
    return dialect.respond(
      'deny',
      'belayd could not read the hook input from the agent, so it is blocking this action to be safe.',
      {},
    );
  }
  const input = dialect.parse(payload, deps.event);
  const agent = dialect.agent(payload, deps.env);
  // Another adapter covers this agent natively (Copilot CLI also runs Claude Code's
  // hooks): answer nothing, so the call is checked once, by that adapter.
  if (dialect.handledElsewhere?.(agent, input, deps.env))
    return dialect.respond('pass', '', { agent });
  const cwd = canonicalPath(input.cwd ?? process.cwd());
  const declared = dialect.workspace?.(deps.env);
  const workspace = declared ? canonicalPath(declared) : findWorkspace(cwd);
  const home = canonicalPath(homeDir(deps.env));
  const stateDir = belaydHome(deps.env);
  const started = Date.now();
  const session = sessionKey(agent, input.sessionId);
  // Agents without a call id get one, so the before and after events pair up for undo.
  if (!input.toolUseId && input.phase !== 'other') {
    const id =
      input.phase === 'pre'
        ? startCall(stateDir, session, input.tool, input.input)
        : finishCall(stateDir, session, input.tool, input.input);
    if (id) input.toolUseId = id;
  }
  const folders = dialect.folders?.(deps.env) ?? [];
  const ctxBase: ActionContext = {
    agent,
    cwd,
    workspace,
    home,
    ...(folders.length > 0 ? { folders } : {}),
  };

  if (input.phase === 'post' || input.phase === 'failed') {
    let snapshot: string | undefined;
    try {
      const action = dialect.toAction(input.tool, input.input, cwd);
      const policy = await loadPolicy({ workspace, belaydHome: stateDir });
      // What the step wrote: what its command says, and what the snapshot saw change,
      // which also catches writes no command shows (`node -e`, `git apply`, `npm pkg set`).
      const written = buildSubjects(action, ctxBase).flatMap((s) => s.writes);
      snapshot = capture(stateDir, policy, action, ctxBase, {
        onChanged: (paths) => written.push(...paths),
        deadline: started + (deps.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000 - SAFETY_MARGIN_MS,
      });
      addSessionWrites(stateDir, session, written);
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
      tool: input.tool,
      toolUseId: input.toolUseId,
      outcome: input.phase === 'failed' ? 'failed' : 'ran',
      snapshot,
    });
    return { stdout: '', exitCode: 0 };
  }
  if (input.phase !== 'pre') return { stdout: '', exitCode: 0 };

  const action = dialect.toAction(input.tool, input.input, cwd);
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
      tool: input.tool,
      toolUseId: input.toolUseId,
      kind: action.kind,
      label: actionLabel(action, workspace),
      input: summarizeInput(input.input ?? {}),
      decision: told,
      durationMs: Date.now() - started,
      ...extra,
    });

  const timeoutMs = (deps.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const watchdog = startWatchdog(
    Math.min(CHECK_DEADLINE_MS, timeoutMs / 2),
    'belayd took too long to check this call, so it is blocked. Ask the user to run `belayd doctor`.',
    path.join(stateDir, 'errors.log'),
  );
  let failMode: 'open' | 'closed' = 'closed';
  try {
    const ctx: ActionContext = {
      ...ctxBase,
      ...(input.tool ? { toolName: input.tool } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
    };
    const policy = await loadPolicy({ workspace, belaydHome: stateDir });
    failMode = policy.failMode;
    // Fault injection for the test suite, which proves that failures block.
    if (deps.env.BELAYD_FAULT === 'after-policy') throw new Error('injected fault');
    if (deps.env.BELAYD_FAULT === 'hang') for (;;);
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

    // Once a call is cleared to run, the watchdog has done its job: a slow snapshot must
    // never turn into a block, and snapshot failures never change a decision.
    const answerBy = started + timeoutMs - SAFETY_MARGIN_MS;
    if (decision.verdict !== 'ask') {
      if (decision.verdict !== 'deny') watchdog.stop();
      const snapshot =
        decision.verdict === 'deny'
          ? undefined
          : capture(stateDir, policy, action, ctx, { deadline: answerBy });
      await audit(decision.verdict, { ...facts, ...(snapshot ? { snapshot } : {}) });
      if (decision.verdict === 'deny') {
        return dialect.respond('deny', blocked(decision.reason, rule), { agent });
      }
      return dialect.respond(decision.verdict, `belayd: ${decision.reason}${rule}`, { agent });
    }

    // Waiting for a person is expected to take a while; it has its own deadline.
    watchdog.extend(timeoutMs - SAFETY_MARGIN_MS / 2);
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
    // Only a call that is cleared to run: an `ask` shown by the agent itself must still
    // be answered in time, or the agent falls back to its own permission mode.
    if (resolution.verdict === 'allow') watchdog.stop();
    const snapshot =
      resolution.verdict === 'deny'
        ? undefined
        : capture(stateDir, policy, action, ctx, { deadline: answerBy });
    await audit(resolution.verdict, {
      ...facts,
      ...(resolution.answeredBy ? { answeredBy: resolution.answeredBy } : {}),
      ...(snapshot ? { snapshot } : {}),
    });
    return dialect.respond(resolution.verdict, resolution.reason, {
      agent,
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
        { agent },
      );
    }
    await audit('deny', { verdict: 'error', reason: `belayd error: ${message}` });
    return dialect.respond(
      'deny',
      `belayd hit an error and is blocking this action to be safe: ${message}. ` +
        'Ask the user to run `belayd doctor`.',
      { agent },
    );
  } finally {
    watchdog.stop();
  }
}

function blocked(reason: string, rule: string): string {
  return (
    `belayd blocked this: ${reason}${rule} ` +
    'Do not try to get around this with a different command. If it is really needed, explain why and let the user decide.'
  );
}
