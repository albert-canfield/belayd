import type { CompiledPolicy } from '../policy/load.js';
import type { Action, ActionContext, Decision } from '../policy/types.js';
import { holdForApproval } from './hold.js';

export interface Resolution {
  /** What to tell the agent. `ask` only when the agent can show its own prompt. */
  verdict: 'ask' | 'allow' | 'deny';
  reason: string;
  /** How a held call was answered: `web`, `tty`, `cli` or `timeout`. */
  answeredBy?: string;
}

export interface ResolveOptions {
  decision: Decision;
  action: Action;
  ctx: ActionContext;
  policy: CompiledPolicy;
  belaydHome: string;
  env: NodeJS.ProcessEnv;
  /** Time left before the agent gives up on the hook. */
  deadlineMs: number;
  /** The agent will show its own prompt if we answer `ask`. */
  canAskNatively: boolean;
  binPath: string;
}

/**
 * Decides who answers an `ask`: the agent's own prompt when it has one, otherwise
 * belayd holds the call and waits for `belayd approve` or the local web page.
 */
export async function resolveAsk(opts: ResolveOptions): Promise<Resolution> {
  const { decision, policy } = opts;
  const rule = decision.ruleId ? ` [rule: ${decision.ruleId}]` : '';
  const channels = policy.approval.channels;

  if (opts.canAskNatively && channels.includes('native')) {
    return { verdict: 'ask', reason: `belayd: ${decision.reason}${rule}` };
  }
  if (!channels.includes('web') && !channels.includes('tty')) {
    return {
      verdict: 'deny',
      reason: `belayd needs a person to approve this, and no approval channel is available here: ${decision.reason}${rule}`,
    };
  }

  const result = await holdForApproval({
    belaydHome: opts.belaydHome,
    policy,
    deadlineMs: opts.deadlineMs,
    binPath: opts.binPath,
    env: opts.env,
    request: {
      agent: opts.ctx.agent,
      ...(opts.ctx.sessionId ? { sessionId: opts.ctx.sessionId } : {}),
      ...(opts.ctx.toolName ? { toolName: opts.ctx.toolName } : {}),
      workspace: opts.ctx.workspace,
      cwd: opts.ctx.cwd,
      label: actionLabel(opts.action),
      kind: opts.action.kind,
      reason: decision.reason,
      ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
    },
  });

  if (result.decision === 'allow') {
    const how =
      result.by === 'timeout'
        ? 'nobody answered and the policy allows on timeout'
        : `approved by the user (${result.by})`;
    return {
      verdict: 'allow',
      reason: `belayd: ${how}. ${decision.reason}${rule}`,
      answeredBy: result.by,
    };
  }
  if (result.by === 'timeout') {
    const seconds = Math.round(result.waitedMs / 1000);
    return {
      verdict: 'deny',
      reason:
        `belayd needed a person to approve this and nobody answered within ${seconds}s, so it is blocked: ${decision.reason}${rule} ` +
        'Tell the user what you wanted to do and why, and let them run `belayd approve` or decide themselves.',
      answeredBy: 'timeout',
    };
  }
  return {
    verdict: 'deny',
    reason: `belayd: the user said no to this. ${decision.reason}${rule} Do not retry it or work around it; ask the user how they want to proceed.`,
    answeredBy: result.by,
  };
}

/** One line (or block) a person can judge quickly. */
export function actionLabel(action: Action): string {
  switch (action.kind) {
    case 'shell':
      return action.command;
    case 'read':
      return `read ${action.path}`;
    case 'write':
      return `write ${action.path}`;
    case 'fetch':
      return `${action.method ?? 'GET'} ${action.url}`;
    case 'mcp': {
      let args: string;
      try {
        args = JSON.stringify(action.args);
      } catch {
        args = '';
      }
      return `${action.server}: ${action.tool} ${args.length > 400 ? `${args.slice(0, 397)}...` : args}`;
    }
    case 'tool':
      return action.name;
  }
}
