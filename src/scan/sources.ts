import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { AgentId } from '../policy/types.js';

/**
 * Reads agents' own session history, so `belayd scan` can show what belayd would have
 * done with the tool calls they already made. Everything stays on this machine.
 *
 * - Claude Code: `$CLAUDE_CONFIG_DIR/projects/**\/*.jsonl` (default `~/.claude/projects`),
 *   one JSON object per line; tool calls are `tool_use` items in assistant messages.
 * - Codex: `$CODEX_HOME/sessions/**\/rollout-*.jsonl` (default `~/.codex/sessions`), with a
 *   `session_meta` line for the folder and `function_call` / `custom_tool_call` items.
 */
export interface PastCall {
  agent: AgentId;
  session: string;
  /** Epoch ms. */
  at: number;
  cwd: string;
  /** The tool as the agent's own hook would name it. */
  tool: string;
  input: Record<string, unknown>;
}

export interface Source {
  agent: AgentId;
  name: string;
  dir: string;
}

export function sources(env: NodeJS.ProcessEnv = process.env): Source[] {
  const home = env.HOME || os.homedir();
  return [
    {
      agent: 'claude-code',
      name: 'Claude Code',
      dir: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'),
    },
    {
      agent: 'codex',
      name: 'Codex',
      dir: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions'),
    },
  ];
}

/** Session files changed since `since`, newest last. */
export function sessionFiles(source: Source, since: number): string[] {
  const out: { file: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const mtime = fs.statSync(p).mtimeMs;
          if (mtime >= since) out.push({ file: p, mtime });
        } catch {
          // gone since the listing
        }
      }
    }
  };
  walk(source.dir, 0);
  return out.sort((a, b) => a.mtime - b.mtime).map((f) => f.file);
}

const CLAUDE_TOOLS = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Grep',
  'Glob',
  'WebFetch',
]);

/** The tool calls in one session file, oldest first. */
export async function* readCalls(
  source: Source,
  file: string,
  since: number,
): AsyncGenerator<PastCall> {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let codexSession = path.basename(file, '.jsonl');
  let codexCwd = '';
  for await (const line of rl) {
    if (line.length > 5_000_000) continue;
    if (source.agent === 'claude-code' && !line.includes('"tool_use"')) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (source.agent === 'claude-code') {
      const at = Date.parse(String(e.timestamp ?? ''));
      if (!(at >= since)) continue;
      const content = (e.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content as Record<string, unknown>[]) {
        if (c.type !== 'tool_use' || typeof c.name !== 'string') continue;
        if (!CLAUDE_TOOLS.has(c.name) && !c.name.startsWith('mcp__')) continue;
        yield {
          agent: 'claude-code',
          session: String(e.sessionId ?? file),
          at,
          cwd: String(e.cwd ?? ''),
          tool: c.name,
          input: (c.input as Record<string, unknown>) ?? {},
        };
      }
      continue;
    }
    // Codex rollout
    const payload = (e.payload as Record<string, unknown> | undefined) ?? {};
    if (e.type === 'session_meta') {
      codexSession = String(payload.id ?? payload.session_id ?? codexSession);
      codexCwd = String(payload.cwd ?? '');
      continue;
    }
    if (e.type === 'turn_context' && typeof payload.cwd === 'string') codexCwd = payload.cwd;
    if (e.type !== 'response_item') continue;
    const at = Date.parse(String(e.timestamp ?? ''));
    if (!(at >= since)) continue;
    const name = String(payload.name ?? '');
    if (
      payload.type === 'function_call' &&
      /^(shell|exec_command|shell_command|local_shell)$/.test(name)
    ) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(String(payload.arguments ?? '{}')) as Record<string, unknown>;
      } catch {
        continue;
      }
      const command = args.command ?? args.cmd;
      const argv = Array.isArray(command) ? (command as unknown[]).map(String) : undefined;
      // `["bash", "-lc", "the command"]` is how Codex runs a command line.
      const text =
        argv && argv.length === 3 && /(^|\/)(ba|z)?sh$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!)
          ? argv[2]
          : command;
      const workdir = typeof args.workdir === 'string' ? args.workdir : codexCwd;
      yield {
        agent: 'codex',
        session: codexSession,
        at,
        cwd: workdir,
        tool: 'Bash',
        input: { command: text },
      };
    } else if (payload.type === 'custom_tool_call' && name === 'apply_patch') {
      yield {
        agent: 'codex',
        session: codexSession,
        at,
        cwd: codexCwd,
        tool: 'apply_patch',
        input: { command: String(payload.input ?? '') },
      };
    }
  }
}
