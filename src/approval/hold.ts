import type { CompiledPolicy } from '../policy/load.js';
import { askDialog, type Dialog, type DialogAnswer } from './dialog.js';
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
  // File-based channels (console, web page) need a pending request on disk. The dialog
  // does not, and when it is the only way to answer, nothing on disk can answer for you.
  const fileChannels = approval.channels.includes('tty') || approval.channels.includes('web');
  if (fileChannels) createRequest(opts.belaydHome, req);
  let dialogAnswer: DialogAnswer | undefined;
  let dialog: Dialog | undefined;
  if (approval.channels.includes('dialog')) {
    const text = `${truncate(req.label, 300)}\n\n${req.reason}${req.ruleId ? ` (${req.ruleId})` : ''}`;
    dialog = askDialog(
      `belayd: ${agentName(req.agent)} is waiting`,
      text,
      timeout / 1000,
      opts.env,
    );
    void dialog.answer.then((a) => (dialogAnswer = a));
  }

  // An open dialog would keep this process alive after the call was answered elsewhere.
  const cleanup = () => {
    dialog?.close();
    closeRequest(opts.belaydHome, req.id);
  };
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
    if (approval.notify && fileChannels) {
      notify(
        'belayd needs a yes or no',
        `${truncate(req.label, 90)}\nRun: belayd approve`,
        opts.env,
      );
    }

    const poll = opts.pollMs ?? 150;
    for (;;) {
      if (dialogAnswer === 'allow' || dialogAnswer === 'deny') {
        return { decision: dialogAnswer, by: 'dialog', waitedMs: Date.now() - now };
      }
      if (dialogAnswer && !fileChannels) {
        // Dialog timed out or could not be shown, and there is no other way to answer.
        return { decision: approval.onTimeout, by: 'timeout', waitedMs: Date.now() - now };
      }
      const d = fileChannels ? readDecision(opts.belaydHome, req.id) : undefined;
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

function agentName(agent: string): string {
  return (
    {
      'claude-code': 'Claude Code',
      codex: 'Codex',
      cursor: 'Cursor',
      copilot: 'Copilot CLI',
      mcp: 'An MCP client',
    }[agent] ?? agent
  );
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 3)}...` : one;
}
