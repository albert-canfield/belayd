import path from 'node:path';
import pc from 'picocolors';
import { AuditLog, type StoredEvent } from '../audit/db.js';
import { Shadow, type Change } from '../snapshots/shadow.js';
import { stepChanges } from '../snapshots/undo.js';
import { belaydHome, findWorkspace } from '../util/paths.js';

const AGENTS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  mcp: 'MCP',
};

interface Common {
  all?: boolean;
  json?: boolean;
}

async function open(): Promise<AuditLog | undefined> {
  const home = belaydHome();
  if (!AuditLog.exists(home)) {
    console.log('No audit log yet. It fills up as soon as an agent runs with belayd installed.');
    return undefined;
  }
  return AuditLog.open(home);
}

export async function log(
  opts: Common & { session?: string; limit?: string; verify?: boolean; only?: string },
): Promise<number> {
  const db = await open();
  if (!db) return 0;
  try {
    if (opts.verify) {
      const r = db.verify();
      if (r.ok)
        console.log(pc.green(`✔ Audit log intact: ${r.checked} events, every hash checks out.`));
      else console.log(pc.red(`✖ Audit log problem at event ${r.brokenAt}: ${r.problem}.`));
      return r.ok ? 0 : 1;
    }
    const workspace = opts.all ? undefined : findWorkspace(process.cwd());
    const session = opts.session ? db.findSession(opts.session, undefined) : undefined;
    if (opts.session && !session) {
      console.error(`No session matches "${opts.session}". See: belayd sessions`);
      return 1;
    }
    const events = db
      .events({
        ...(session ? { session } : workspace ? { workspace } : {}),
        limit: Number(opts.limit ?? 50),
      })
      .filter((e) => e.phase !== 'post')
      .filter((e) => !opts.only || e.decision === opts.only || e.verdict === opts.only);
    if (opts.json) {
      console.log(JSON.stringify(events, null, 2));
      return 0;
    }
    if (events.length === 0) {
      console.log(
        workspace ? `Nothing logged for ${workspace} yet. Try --all.` : 'Nothing logged yet.',
      );
      return 0;
    }
    for (const e of events) {
      const time = new Date(e.at).toLocaleString(undefined, {
        dateStyle: 'short',
        timeStyle: 'medium',
      });
      console.log(
        `${pc.dim(time)}  ${icon(e)}  ${pc.dim(shortSession(e.session))} ${pc.dim(`#${e.step}`)}  ${oneLine(e.label ?? e.tool ?? '', 80)}${e.ruleId ? pc.dim(`  ${e.ruleId}`) : ''}`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

export async function sessions(opts: Common & { limit?: string }): Promise<number> {
  const db = await open();
  if (!db) return 0;
  try {
    const workspace = opts.all ? undefined : findWorkspace(process.cwd());
    const list = db.sessions({
      ...(workspace ? { workspace } : {}),
      limit: Number(opts.limit ?? 20),
    });
    if (opts.json) {
      console.log(JSON.stringify(list, null, 2));
      return 0;
    }
    if (list.length === 0) {
      console.log(workspace ? `No sessions for ${workspace} yet. Try --all.` : 'No sessions yet.');
      return 0;
    }
    for (const s of list) {
      const flags = [
        s.denied ? pc.red(`${s.denied} blocked`) : '',
        s.asked ? pc.yellow(`${s.asked} asked`) : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.log(
        `${pc.bold(shortSession(s.session))}  ${AGENTS[s.agent] ?? s.agent}  ${path.basename(s.workspace)}  ` +
          `${pc.dim(when(s.started))}  ${s.steps} step${s.steps === 1 ? '' : 's'} ${flags}`,
      );
    }
    console.log(pc.dim('\nReplay one: belayd replay <id>    Undo a step: belayd undo <step>'));
    return 0;
  } finally {
    db.close();
  }
}

export async function replay(id: string | undefined, opts: Common): Promise<number> {
  const db = await open();
  if (!db) return 0;
  try {
    const session = db.findSession(id, id || opts.all ? undefined : findWorkspace(process.cwd()));
    if (!session) {
      console.error(
        id
          ? `No session matches "${id}". See: belayd sessions --all`
          : 'No sessions for this project yet.',
      );
      return 1;
    }
    const events = db.events({ session });
    if (opts.json) {
      console.log(JSON.stringify(events, null, 2));
      return 0;
    }
    printReplay(events, fileChanges(events));
    return 0;
  } finally {
    db.close();
  }
}

export async function gc(opts: { olderThan?: string }): Promise<number> {
  const days = Number(/^(\d+)d?$/.exec(opts.olderThan ?? '30d')?.[1] ?? NaN);
  if (!Number.isFinite(days) || days < 1) {
    console.error('Use a number of days, for example: belayd gc --older-than 30d');
    return 64;
  }
  const db = await open();
  if (!db) return 0;
  try {
    const removed = db.gc(Date.now() - days * 86_400_000);
    console.log(`Removed ${removed} events older than ${days} days.`);
    return 0;
  } finally {
    db.close();
  }
}

/** Files each step changed, from its snapshots. Empty when snapshots are off or missing. */
function fileChanges(events: StoredEvent[]): Map<number, Change[]> {
  const out = new Map<number, Change[]>();
  const workspace = events[0]?.workspace;
  if (!workspace) return out;
  try {
    const shadow = new Shadow(belaydHome(), workspace);
    if (!shadow.exists()) return out;
    for (const s of stepChanges(events, shadow)) out.set(s.step, s.changes);
  } catch {
    // replay still works without file details
  }
  return out;
}

export function printReplay(events: StoredEvent[], changes = new Map<number, Change[]>()): void {
  const pre = events.filter((e) => e.phase === 'pre');
  const post = new Map(
    events.filter((e) => e.phase === 'post' && e.toolUseId).map((e) => [e.toolUseId!, e]),
  );
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) return;

  const minutes = Math.max(1, Math.round((last.at - first.at) / 60_000));
  console.log(
    `${pc.bold(`Session ${shortSession(first.session)}`)}  ${AGENTS[first.agent] ?? first.agent} · ${path.basename(first.workspace)} · ` +
      `${when(first.at)} · ${minutes} min · ${pre.length} step${pre.length === 1 ? '' : 's'}`,
  );
  const blocked = pre.filter((e) => e.decision === 'deny').length;
  const asked = pre.filter((e) => e.verdict === 'ask').length;
  if (blocked || asked) console.log(pc.dim(`${blocked} blocked, ${asked} asked about`));
  console.log('');

  const width = String(pre.at(-1)?.step ?? 1).length;
  for (const e of pre) {
    const ran = e.toolUseId ? post.get(e.toolUseId) : undefined;
    const time = new Date(e.at).toLocaleTimeString(undefined, { hour12: false });
    const head = `${pc.dim(String(e.step).padStart(width))}  ${pc.dim(time)}  ${icon(e)}  ${pc.dim((e.tool ?? e.kind ?? '').padEnd(6))}`;
    const lines = (e.label ?? '').split(`${e.workspace}/`).join('').split('\n');
    console.log(`${head} ${oneLine(lines[0] ?? '', 90)}${lines.length > 1 ? pc.dim(' …') : ''}`);
    const story = outcome(e, ran);
    const pad = ' '.repeat(width + 2 + time.length + 5);
    if (story) console.log(`${pad}${story}`);
    for (const c of changes.get(e.step) ?? []) {
      const counts = c.added !== undefined ? pc.dim(` +${c.added} -${c.removed ?? 0}`) : '';
      const mark =
        c.status === 'A' ? pc.green('A') : c.status === 'D' ? pc.red('D') : pc.yellow('M');
      console.log(`${pad}${mark} ${c.path}${counts}`);
    }
  }
}

function outcome(e: StoredEvent, ran: StoredEvent | undefined): string {
  const result = ran
    ? ran.outcome === 'failed'
      ? pc.yellow('failed')
      : 'ran'
    : pc.dim('did not run');
  if (e.decision === 'deny') {
    if (e.answeredBy === 'timeout') return pc.red(`no answer in time, blocked`) + rule(e);
    if (e.answeredBy) return pc.red(`you said no (${e.answeredBy})`) + rule(e);
    return pc.red(`blocked: ${oneLine(e.reason ?? '', 90)}`) + rule(e);
  }
  if (e.verdict === 'ask') {
    if (e.answeredBy)
      return `${pc.green(`you allowed it (${e.answeredBy})`)} → ${result}${rule(e)}`;
    return `${pc.yellow('asked in Claude Code')} → ${ran ? pc.green('approved, ran') : pc.dim('not approved')}${rule(e)}`;
  }
  if (ran?.outcome === 'failed') return pc.yellow('failed');
  if (!ran && e.toolUseId) return pc.dim('did not run');
  return '';
}

function rule(e: StoredEvent): string {
  return e.ruleId ? pc.dim(`  [${e.ruleId}]`) : '';
}

function icon(e: StoredEvent): string {
  if (e.decision === 'deny') return pc.red('✖');
  if (e.verdict === 'ask') return pc.yellow('?');
  if (e.decision === 'allow') return pc.green('✔');
  return pc.dim('·');
}

function shortSession(s: string): string {
  const id = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  return id.slice(0, 8);
}

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
