import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir } from '../util/paths.js';

/**
 * Pending approvals are plain JSON files under $BELAYD_HOME/approvals, so the hook,
 * `belayd approve` and the web page can share them without a daemon or database.
 *
 *   pending/<id>.json   written by the hook that is waiting
 *   decided/<id>.json   written by whoever answers first
 */

export interface ApprovalRequest {
  id: string;
  createdAt: number;
  expiresAt: number;
  agent: string;
  sessionId?: string;
  workspace: string;
  cwd: string;
  /** What the agent wants to do: a command, a path or a URL. */
  label: string;
  kind: string;
  toolName?: string;
  reason: string;
  ruleId?: string;
  /** The waiting hook process. A dead pid means nobody is waiting any more. */
  pid: number;
}

export type ApprovalAnswer = 'allow' | 'deny';

export interface ApprovalDecision {
  id: string;
  decision: ApprovalAnswer;
  by: string;
  at: number;
}

export function approvalsDir(belaydHome: string): string {
  return path.join(belaydHome, 'approvals');
}

export function newId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function createRequest(belaydHome: string, req: ApprovalRequest): void {
  writeJson(path.join(approvalsDir(belaydHome), 'pending', `${req.id}.json`), req);
}

/** Records an answer. Returns false when the request no longer exists or was already answered. */
export function decide(
  belaydHome: string,
  id: string,
  decision: ApprovalAnswer,
  by: string,
): boolean {
  if (!/^[a-z0-9-]+$/.test(id)) return false;
  const dir = approvalsDir(belaydHome);
  if (!fs.existsSync(path.join(dir, 'pending', `${id}.json`))) return false;
  const target = path.join(dir, 'decided', `${id}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const record: ApprovalDecision = { id, decision, by, at: Date.now() };
  try {
    // `wx` makes the first answer win when the console and the web page race.
    fs.writeFileSync(target, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function readDecision(belaydHome: string, id: string): ApprovalDecision | undefined {
  try {
    const text = fs.readFileSync(
      path.join(approvalsDir(belaydHome), 'decided', `${id}.json`),
      'utf8',
    );
    return JSON.parse(text) as ApprovalDecision;
  } catch {
    return undefined;
  }
}

/** Removes a request and its answer once the waiting hook is done with them. */
export function closeRequest(belaydHome: string, id: string): void {
  const dir = approvalsDir(belaydHome);
  for (const sub of ['pending', 'decided']) {
    fs.rmSync(path.join(dir, sub, `${id}.json`), { force: true });
  }
}

/** Requests someone is still waiting on, oldest first. Cleans up abandoned ones. */
export function listPending(belaydHome: string, now = Date.now()): ApprovalRequest[] {
  const dir = path.join(approvalsDir(belaydHome), 'pending');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: ApprovalRequest[] = [];
  for (const name of names) {
    let req: ApprovalRequest;
    try {
      req = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as ApprovalRequest;
    } catch {
      continue;
    }
    if (req.expiresAt < now - 5000 || !alive(req.pid)) {
      closeRequest(belaydHome, req.id);
      continue;
    }
    if (readDecision(belaydHome, req.id)) continue;
    out.push(req);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function writeJson(file: string, data: unknown): void {
  ensurePrivateDir(path.dirname(path.dirname(path.dirname(file))));
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
