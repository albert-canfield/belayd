import readline from 'node:readline';
import pc from 'picocolors';
import { decide, listPending, type ApprovalRequest } from '../approval/store.js';
import { belaydHome } from '../util/paths.js';

const AGENTS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'Copilot CLI',
  gemini: 'Gemini CLI',
  mcp: 'MCP server',
};

export interface ApproveOptions {
  allow?: boolean;
  deny?: boolean;
  list?: boolean;
  json?: boolean;
}

export async function approve(id: string | undefined, opts: ApproveOptions): Promise<number> {
  const home = belaydHome();

  // Approvals are for people. Claude Code marks every process it starts for a tool
  // call with CLAUDE_CODE_CHILD_SESSION=1, so an agent cannot answer its own request.
  if ((id || !opts.list) && !opts.json && insideAgent(process.env)) {
    console.error(
      'belayd approve must be run by a person, not from inside an agent session. Open a terminal and run it there.',
    );
    return 77;
  }

  if (id) {
    if (opts.allow === opts.deny) {
      console.error(
        'Say what to do: belayd approve <id> --allow   or   belayd approve <id> --deny',
      );
      return 64;
    }
    const ok = decide(home, id, opts.allow ? 'allow' : 'deny', 'cli');
    if (!ok) {
      console.error(`No request ${id} is waiting (it may have been answered or timed out).`);
      return 1;
    }
    console.log(opts.allow ? pc.green(`✔ Allowed ${id}`) : pc.red(`✖ Denied ${id}`));
    return 0;
  }

  if (opts.json) {
    console.log(JSON.stringify(listPending(home), null, 2));
    return 0;
  }
  if (opts.list || !process.stdin.isTTY || !process.stdout.isTTY) {
    const pending = listPending(home);
    if (pending.length === 0) console.log('Nothing is waiting for approval.');
    for (const p of pending) {
      console.log(`${pc.bold(p.id)}  ${AGENTS[p.agent] ?? p.agent}  ${left(p)} left`);
      console.log(`  ${p.label}`);
      console.log(pc.dim(`  ${p.reason}`));
    }
    return 0;
  }
  return console_(home);
}

/** Live console: shows the oldest request and answers it with a key press. */
function console_(home: string): Promise<number> {
  return new Promise((resolve) => {
    let index = 0;
    let flash = '';
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const draw = () => {
      const pending = listPending(home);
      if (index >= pending.length) index = 0;
      const lines: string[] = [
        `${pc.bold('belayd approve')}  ${pc.dim('watching for requests · q to quit')}`,
        '',
      ];
      const p = pending[index];
      if (!p) {
        lines.push(
          pc.dim('  Nothing waiting. Leave this open; requests show up here as they arrive.'),
        );
      } else {
        lines.push(
          `  ${pc.bold(AGENTS[p.agent] ?? p.agent)} ${pc.dim('·')} ${project(p.workspace)} ${pc.dim('·')} ${left(p)} left`,
          '',
          ...p.label.split('\n').map((l) => `  ${pc.cyan(l)}`),
          '',
          `  ${p.reason}${p.ruleId ? pc.dim(`  (${p.ruleId})`) : ''}`,
          '',
          `  ${pc.green('[a] allow')}   ${pc.red('[d] deny')}   ${pc.dim('[n] next')}        ${pc.dim(`${index + 1} of ${pending.length} waiting`)}`,
        );
      }
      if (flash) lines.push('', `  ${flash}`);
      process.stdout.write(`\x1b[2J\x1b[H${lines.join('\n')}\n`);
      return p;
    };

    let current = draw();
    const timer = setInterval(() => (current = draw()), 500);

    const finish = (code: number) => {
      clearInterval(timer);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      resolve(code);
    };

    process.stdin.on('keypress', (_s: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) return finish(0);
      if (key.name === 'n') index++;
      if (current && (key.name === 'a' || key.name === 'd')) {
        const decision = key.name === 'a' ? 'allow' : 'deny';
        const ok = decide(home, current.id, decision, 'tty');
        flash = ok
          ? decision === 'allow'
            ? pc.green(`✔ Allowed: ${oneLine(current.label)}`)
            : pc.red(`✖ Denied: ${oneLine(current.label)}`)
          : pc.dim('Already answered elsewhere.');
      }
      current = draw();
    });
  });
}

function left(p: ApprovalRequest): string {
  const s = Math.max(0, Math.ceil((p.expiresAt - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function project(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 70 ? `${t.slice(0, 67)}...` : t;
}

/** True when this process was started by an agent's tool call rather than by a person. */
export function insideAgent(env: NodeJS.ProcessEnv): boolean {
  return (
    env.CLAUDE_CODE_CHILD_SESSION === '1' ||
    env.CODEX_SANDBOX !== undefined ||
    env.CODEX_SANDBOX_NETWORK_DISABLED === '1'
  );
}
