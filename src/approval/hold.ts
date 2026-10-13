import type { CompiledPolicy } from '../policy/load.js';
import { notify } from './notify.js';
import {
  closeRequest,
  createRequest,
  newId,
  readDecision,
  type ApprovalAnswer,
  type ApprovalRequest,
} from './store.js';
import { ensureUiServer } from './ui-state.js';

export interface HoldOptions {
  belaydHome: string;
  policy: CompiledPolicy;
  /** Hard limit from the agent's hook timeout. belayd must answer before it. */
  deadlineMs: number;
  binPath: string;
  env: NodeJS.ProcessEnv;
  request: Omit<ApprovalRequest, 'id' | 'createdAt' | 'expiresAt' | 'pid'>;
  /** For tests. */
  pollMs?: number;
}

export interface HoldResult {
  decision: ApprovalAnswer;
  /** `web`, `tty`, `cli` or `timeout`. */
  by: string;
  waitedMs: number;
}

/**
 * Holds a tool call until a person answers in `belayd approve` or the web page,
 * or until the deadline. Used wherever the agent cannot show its own prompt.
 */
export async function holdForApproval(opts: HoldOptions): Promise<HoldResult> {
  const { approval } = opts.policy;
  const timeout = Math.max(1000, Math.min(approval.timeoutMs, opts.deadlineMs));
  const now = Date.now();
  const req: ApprovalRequest = {
    ...opts.request,
    id: newId(),
    createdAt: now,
    expiresAt: now + timeout,
    pid: process.pid,
  };
  createRequest(opts.belaydHome, req);

  const cleanup = () => closeRequest(opts.belaydHome, req.id);
  const onSignal = () => {
    cleanup();
    process.exit(2);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    if (approval.channels.includes('web')) {
      try {
        ensureUiServer({
          belaydHome: opts.belaydHome,
          binPath: opts.binPath,
          port: approval.port,
          env: opts.env,
        });
      } catch {
        // the terminal console still works
      }
    }
    if (approval.notify) {
      notify(
        'belayd needs a yes or no',
        `${truncate(req.label, 90)}\nRun: belayd approve`,
        opts.env,
      );
    }

    const poll = opts.pollMs ?? 150;
    for (;;) {
      const d = readDecision(opts.belaydHome, req.id);
      if (d) return { decision: d.decision, by: d.by, waitedMs: Date.now() - now };
      if (Date.now() >= req.expiresAt) {
        return { decision: approval.onTimeout, by: 'timeout', waitedMs: Date.now() - now };
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  } finally {
    cleanup();
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 3)}...` : one;
}
