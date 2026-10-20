import path from 'node:path';
import pc from 'picocolors';
import { agentName } from '../agents/registry.js';
import { LIVE_MS, liveSessions, liveWorkspaces, type LiveSession } from '../audit/live.js';
import { untrustedGit } from '../util/git.js';
import { belaydHome, canonicalPath, findWorkspace } from '../util/paths.js';

/**
 * `belayd ps`: the agents working in this project right now, what each one is doing and
 * which of its changes are not committed yet. Read from the same per-project record the
 * multi-agent checks use, so it costs the agents nothing.
 */

interface PsOptions {
  all?: boolean;
  json?: boolean;
  watch?: boolean;
}

interface FileRow {
  path: string;
  /** Not committed yet; undefined outside Git. */
  uncommitted: boolean | undefined;
  /** Another live agent changed it too. */
  shared: string[];
}

interface SessionRow {
  session: string;
  agent: string;
  name: string;
  first: number;
  last: number;
  calls: number;
  doing: string | undefined;
  files: FileRow[];
}

const MAX_FILES = 6;

export async function ps(opts: PsOptions): Promise<number> {
  const home = belaydHome();
  const render = () => {
    const now = Date.now();
    const workspaces = opts.all ? liveWorkspaces(home, now) : [findWorkspace(process.cwd())];
    const projects = workspaces.map((workspace) => ({
      workspace,
      sessions: rows(liveSessions(home, workspace, now), workspace),
    }));
    if (opts.json) return JSON.stringify(projects, null, 2);
    return projects.map((p) => show(p.workspace, p.sessions, now, opts.all === true)).join('\n\n');
  };

  if (!opts.watch || opts.json || !process.stdout.isTTY) {
    console.log(render());
    return 0;
  }
  // Redraw every two seconds until Ctrl-C.
  for (;;) {
    process.stdout.write(`\x1b[2J\x1b[H${render()}\n\n${pc.dim('Watching. Ctrl-C to stop.')}\n`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function rows(sessions: LiveSession[], workspace: string): SessionRow[] {
  const dirty = uncommittedFiles(workspace);
  // Who changed each file, newest first.
  const writers = new Map<string, { session: string; at: number }[]>();
  for (const s of sessions) {
    for (const [file, at] of s.writes) {
      const key = canonicalPath(file);
      const list = writers.get(key) ?? [];
      if (!list.some((w) => w.session === s.session)) list.push({ session: s.session, at });
      writers.set(key, list);
    }
  }
  const names = new Map(sessions.map((s) => [s.session, agentName(s.agent)]));
  return sessions.map((s) => {
    const files = [...new Set([...s.writes.keys()].map(canonicalPath))]
      .map((file): FileRow => {
        const others = (writers.get(file) ?? []).filter((w) => w.session !== s.session);
        return {
          path: path.relative(workspace, file) || file,
          uncommitted: dirty ? dirty.has(file) : undefined,
          shared: others.map((w) => `${names.get(w.session)} ${short(w.session)}`),
        };
      })
      .sort(
        (a, b) =>
          Number(b.uncommitted ?? 0) - Number(a.uncommitted ?? 0) || a.path.localeCompare(b.path),
      );
    return {
      session: s.session,
      agent: s.agent,
      name: agentName(s.agent),
      first: s.first,
      last: s.last,
      calls: s.calls,
      doing: s.lastLabel,
      files,
    };
  });
}

function show(workspace: string, sessions: SessionRow[], now: number, all: boolean): string {
  const name = path.basename(workspace);
  const minutes = LIVE_MS / 60_000;
  if (sessions.length === 0) {
    return `${pc.bold(`belayd ps · ${name}`)}\nNo agent has worked here in the last ${minutes} minutes.${all ? '' : pc.dim(' Every project: belayd ps --all')}`;
  }
  const lines = [
    `${pc.bold(`belayd ps · ${name}`)} · ${sessions.length} agent${sessions.length === 1 ? '' : 's'} working`,
  ];
  for (const s of sessions) {
    lines.push(
      '',
      `${pc.bold(s.name)}  ${short(s.session)}  ${pc.dim(
        `active ${ago(now - s.last)} · ${s.calls} call${s.calls === 1 ? '' : 's'} since ${clock(s.first)}`,
      )}`,
    );
    if (s.doing) lines.push(`  last     ${oneLine(s.doing, 70)}`);
    const open = s.files.filter((f) => f.uncommitted !== false);
    if (open.length > 0) {
      const shown = open.slice(0, MAX_FILES).map((f) => f.path);
      const more = open.length > MAX_FILES ? ` and ${open.length - MAX_FILES} more` : '';
      const committed = open[0]!.uncommitted === undefined ? '' : pc.dim(' · not committed');
      lines.push(`  changed  ${shown.join(', ')}${more}${committed}`);
    }
    for (const f of open.filter((x) => x.shared.length > 0)) {
      lines.push(pc.yellow(`  ! ${f.path} was also changed by ${f.shared.join(', ')}`));
    }
  }
  lines.push(
    '',
    pc.dim(
      `belayd asks before one of them throws away, stashes, commits or overwrites another's uncommitted work.`,
    ),
  );
  return lines.join('\n');
}

/** Files with changes Git has not committed, by absolute path; undefined outside Git. */
function uncommittedFiles(workspace: string): Set<string> | undefined {
  try {
    const top = canonicalPath(
      untrustedGit(['rev-parse', '--show-toplevel'], { cwd: workspace }).trim(),
    );
    const out = untrustedGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: top,
    });
    const files = new Set<string>();
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!;
      if (entry.length < 4) continue;
      files.add(path.join(top, entry.slice(3)));
      if (entry[0] === 'R' || entry[0] === 'C') i++;
    }
    return files;
  } catch {
    return undefined;
  }
}

function short(session: string): string {
  const id = session.includes(':') ? session.slice(session.indexOf(':') + 1) : session;
  return id.slice(0, 8);
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? 'just now' : `${m} min ago`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
