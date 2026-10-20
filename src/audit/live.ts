import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Which agents are at work in a project, and which files each one changed: one line per
 * finished tool call, appended to a file per project and hour. Lines are only ever
 * appended, so agents running in parallel never lose each other's lines, and files older
 * than a few hours are deleted when a new hour starts.
 *
 * It answers two questions: is another agent about to wreck this one's uncommitted work
 * (src/policy/clobber.ts), and who is working here right now (`belayd ps`).
 */

/** An agent counts as still working this long after its last tool call. */
export const LIVE_MS = 30 * 60 * 1000;
const BUCKET_MS = 60 * 60 * 1000;
const KEEP_BUCKETS = 3;
/** A runaway file is not read in full on the hook path. */
const MAX_BUCKET_BYTES = 8 * 1024 * 1024;

interface Line {
  /** When the call finished, epoch ms. */
  t: number;
  /** belayd's session key, `agent:session-id`. */
  s: string;
  a: string;
  /** Files the call said it would change. */
  w?: string[];
  /** What it was, for `belayd ps`. */
  l?: string;
}

export interface LiveSession {
  session: string;
  agent: string;
  /** Last tool call, epoch ms. */
  last: number;
  first: number;
  calls: number;
  lastLabel: string | undefined;
  /** File, and when this session last changed it. */
  writes: Map<string, number>;
}

function liveDir(belaydHome: string, workspace: string): string {
  const id = crypto.createHash('sha256').update(workspace).digest('hex').slice(0, 16);
  return path.join(belaydHome, 'live', id);
}

/** Records one finished tool call. Never throws: this only costs the multi-agent checks. */
export function noteCall(
  belaydHome: string,
  workspace: string,
  call: { session: string; agent: string; writes: string[]; label?: string },
  now = Date.now(),
): void {
  try {
    const dir = liveDir(belaydHome, workspace);
    const bucket = Math.floor(now / BUCKET_MS);
    const file = path.join(dir, `${bucket}.jsonl`);
    const fresh = !fs.existsSync(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line: Line = { t: now, s: call.session, a: call.agent };
    if (call.writes.length > 0) line.w = [...new Set(call.writes)];
    if (call.label) line.l = call.label.slice(0, 200);
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    if (fresh) {
      // Which project this is, for `belayd ps --all`.
      fs.writeFileSync(path.join(dir, 'workspace'), workspace, { mode: 0o600 });
      for (const name of fs.readdirSync(dir)) {
        const b = Number(name.replace(/\.jsonl$/, ''));
        if (Number.isFinite(b) && b < bucket - KEEP_BUCKETS) fs.rmSync(path.join(dir, name));
      }
    }
  } catch {
    // only costs the multi-agent checks for this call
  }
}

/** Sessions in this project with a tool call in the last `windowMs`, newest first. */
export function liveSessions(
  belaydHome: string,
  workspace: string,
  now = Date.now(),
  windowMs = LIVE_MS,
): LiveSession[] {
  const dir = liveDir(belaydHome, workspace);
  const since = now - windowMs;
  const sessions = new Map<string, LiveSession>();
  for (let b = Math.floor(since / BUCKET_MS); b <= Math.floor(now / BUCKET_MS); b++) {
    let text: string;
    try {
      const file = path.join(dir, `${b}.jsonl`);
      if (fs.statSync(file).size > MAX_BUCKET_BYTES) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        continue; // a line cut short by a crash
      }
      if (typeof line.t !== 'number' || typeof line.s !== 'string' || line.t < since) continue;
      let s = sessions.get(line.s);
      if (!s) {
        s = {
          session: line.s,
          agent: String(line.a),
          last: line.t,
          first: line.t,
          calls: 0,
          lastLabel: undefined,
          writes: new Map(),
        };
        sessions.set(line.s, s);
      }
      s.calls++;
      s.first = Math.min(s.first, line.t);
      if (line.t >= s.last) {
        s.last = line.t;
        if (line.l) s.lastLabel = line.l;
      }
      for (const w of Array.isArray(line.w) ? line.w : []) {
        if (typeof w === 'string' && (s.writes.get(w) ?? 0) <= line.t) s.writes.set(w, line.t);
      }
    }
  }
  return [...sessions.values()].sort((a, b) => b.last - a.last);
}

/** Projects with an agent at work in the last `windowMs`. */
export function liveWorkspaces(belaydHome: string, now = Date.now(), windowMs = LIVE_MS): string[] {
  const root = path.join(belaydHome, 'live');
  const out: string[] = [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const id of dirs) {
    try {
      const workspace = fs.readFileSync(path.join(root, id, 'workspace'), 'utf8');
      if (liveSessions(belaydHome, workspace, now, windowMs).length > 0) out.push(workspace);
    } catch {
      // a project from before belayd kept its name, or one being written right now
    }
  }
  return out.sort();
}
