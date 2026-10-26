import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { AgentId } from '../policy/types.js';
import type { SecretSighting, TranscriptSecrets } from './secrets.js';

/**
 * Reads agents' own session history, so `belayd scan` can show what belayd would have
 * done with the tool calls they already made, and which secrets reached them. Everything
 * stays on this machine.
 *
 * - Claude Code: `$CLAUDE_CONFIG_DIR/projects/**\/*.jsonl` (default `~/.claude/projects`),
 *   one JSON object per line; tool calls are `tool_use` items in assistant messages.
 * - Codex: `$CODEX_HOME/sessions/**\/rollout-*.jsonl` (default `~/.codex/sessions`), with a
 *   `session_meta` line for the folder and `function_call` / `custom_tool_call` items.
 *   Archived sessions (`archived_sessions`) are read for secrets only.
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
  /** Sessions the person put away: they still hold secrets, but are not replayed. */
  archive?: boolean;
}

export function sources(env: NodeJS.ProcessEnv = process.env): Source[] {
  const home = env.HOME || os.homedir();
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  return [
    {
      agent: 'claude-code',
      name: 'Claude Code',
      dir: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'),
    },
    { agent: 'codex', name: 'Codex', dir: path.join(codex, 'sessions') },
    { agent: 'codex', name: 'Codex', dir: path.join(codex, 'archived_sessions'), archive: true },
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

export type HistoryEntry =
  { call: PastCall; secret?: never } | { secret: SecretSighting; call?: never };

export interface ReadOptions {
  /** Tool calls to replay; off for archived sessions. Default on. */
  calls?: boolean;
  /** Also report secrets, found with this. */
  secrets?: TranscriptSecrets;
  /** Folders whose secrets count. Default every folder. */
  keep?: (cwd: string) => boolean;
}

/**
 * The tool calls in one session file, oldest first, and with `secrets` the keys and tokens
 * in it. Each line is parsed at most once for both. Claude Code lines that hold neither are
 * not parsed at all, which keeps a scan of a large history fast.
 */
export async function* readHistory(
  source: Source,
  file: string,
  since: number,
  opts: ReadOptions = {},
): AsyncGenerator<HistoryEntry> {
  const finder = opts.secrets;
  const calls = opts.calls !== false && !source.archive;
  const keep = opts.keep ?? (() => true);
  const claude = source.agent === 'claude-code';
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let session = path.basename(file, '.jsonl');
  let cwd = '';
  let last = NaN;
  // One output stored twice (Claude Code's `toolUseResult`, Codex's `exec_command_end`) counts once.
  const counted = new Set<string>();
  const sightings = function* (e: unknown, at: number): Generator<HistoryEntry> {
    for (const f of finder!.find(e, cwd)) {
      if (f.call) {
        const key = `${f.fingerprint}|${f.place}|${f.call}`;
        if (counted.has(key)) continue;
        counted.add(key);
      }
      yield { secret: { ...f, agent: source.agent, session, file, at, cwd } };
    }
  };

  for await (const line of rl) {
    if (line.length > 5_000_000) continue;
    const toolUse = calls && claude && line.includes('"tool_use"');
    // Answered before parsing when the folder is known; undefined means not asked yet.
    let hint: boolean | undefined;
    if (claude && !toolUse) {
      if (!finder) continue;
      if (cwd) {
        hint = keep(cwd) && finder.mayHold(line, cwd);
        if (!hint) continue;
      }
    }
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e === null || typeof e !== 'object') continue;
    const stamp = Date.parse(String(e.timestamp ?? ''));
    if (stamp >= 0) last = stamp;

    if (claude) {
      if (typeof e.cwd === 'string' && e.cwd && e.cwd !== cwd) {
        cwd = e.cwd;
        hint = undefined;
      }
      if (typeof e.sessionId === 'string' && e.sessionId) session = e.sessionId;
      const at = stamp >= 0 ? stamp : last;
      if (finder && at >= since && (hint ?? (keep(cwd) && finder.mayHold(line, cwd))))
        yield* sightings(e, at);
      if (!toolUse || !(stamp >= since)) continue;
      const content = (e.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content as Record<string, unknown>[]) {
        if (c.type !== 'tool_use' || typeof c.name !== 'string') continue;
        if (!CLAUDE_TOOLS.has(c.name) && !c.name.startsWith('mcp__')) continue;
        yield {
          call: {
            agent: 'claude-code',
            session: String(e.sessionId ?? file),
            at: stamp,
            cwd: String(e.cwd ?? ''),
            tool: c.name,
            input: (c.input as Record<string, unknown>) ?? {},
          },
        };
      }
      continue;
    }
    // Codex rollout
    const payload = (e.payload as Record<string, unknown> | undefined) ?? {};
    if (e.type === 'session_meta') {
      session = String(payload.id ?? payload.session_id ?? session);
      cwd = String(payload.cwd ?? '');
    }
    if (e.type === 'turn_context' && typeof payload.cwd === 'string') cwd = payload.cwd;
    const at = stamp >= 0 ? stamp : last;
    if (finder && at >= since && keep(cwd) && !finder.repeats(e) && finder.mayHold(line, cwd))
      yield* sightings(e, at);
    if (!calls || e.type !== 'response_item' || !(stamp >= since)) continue;
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
      const workdir = typeof args.workdir === 'string' ? args.workdir : cwd;
      yield {
        call: {
          agent: 'codex',
          session,
          at: stamp,
          cwd: workdir,
          tool: 'Bash',
          input: { command: text },
        },
      };
    } else if (payload.type === 'custom_tool_call' && name === 'apply_patch') {
      yield {
        call: {
          agent: 'codex',
          session,
          at: stamp,
          cwd,
          tool: 'apply_patch',
          input: { command: String(payload.input ?? '') },
        },
      };
    }
  }
}
