import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ensurePrivateDir } from '../util/paths.js';

/**
 * The audit trail: one append-only SQLite table under $BELAYD_HOME.
 *
 * Triggers reject UPDATE and DELETE, and every row stores the hash of the row before it,
 * so edits are detectable with `belayd log --verify`. Someone with write access to the
 * file can still rebuild the whole chain; this guards against accidents and casual
 * tampering, not against an attacker who owns your account.
 */

export interface AuditEvent {
  session: string;
  /** `pre`: belayd decided. `post`: the tool ran (or failed). `undo`: files were restored. */
  phase: 'pre' | 'post' | 'undo';
  at: number;
  agent: string;
  workspace: string;
  cwd?: string | undefined;
  tool?: string | undefined;
  toolUseId?: string | undefined;
  kind?: string | undefined;
  /** What happened, redacted. */
  label?: string | undefined;
  /** The tool input as JSON, redacted and with large values shortened. */
  input?: string | undefined;
  /** What the policy said: allow, ask, deny, pass. */
  verdict?: string | undefined;
  /** What belayd told the agent after any approval: allow, ask, deny, pass. */
  decision?: string | undefined;
  /** For `post`: ran or failed. */
  outcome?: string | undefined;
  reason?: string | undefined;
  ruleId?: string | undefined;
  /** For held calls: web, tty, cli or timeout. */
  answeredBy?: string | undefined;
  /** Snapshot reference, filled in by M5. */
  snapshot?: string | undefined;
  durationMs?: number | undefined;
}

export interface StoredEvent extends AuditEvent {
  seq: number;
  step: number;
  prevHash: string;
  hash: string;
}

const COLUMNS = [
  'session',
  'step',
  'phase',
  'at',
  'agent',
  'workspace',
  'cwd',
  'tool',
  'tool_use_id',
  'kind',
  'label',
  'input',
  'verdict',
  'decision',
  'outcome',
  'reason',
  'rule_id',
  'answered_by',
  'snapshot',
  'duration_ms',
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL,
  step INTEGER NOT NULL,
  phase TEXT NOT NULL,
  at INTEGER NOT NULL,
  agent TEXT NOT NULL,
  workspace TEXT NOT NULL,
  cwd TEXT, tool TEXT, tool_use_id TEXT, kind TEXT, label TEXT, input TEXT,
  verdict TEXT, decision TEXT, outcome TEXT, reason TEXT, rule_id TEXT,
  answered_by TEXT, snapshot TEXT, duration_ms INTEGER,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events (session, seq);
CREATE INDEX IF NOT EXISTS events_workspace ON events (workspace, seq);
CREATE INDEX IF NOT EXISTS events_tool_use ON events (session, tool_use_id);
CREATE TRIGGER IF NOT EXISTS events_append_only_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'the belayd audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_append_only_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'the belayd audit log is append-only; use belayd gc'); END;
`;

let sqliteModule: typeof import('node:sqlite') | undefined;

/** node:sqlite prints an ExperimentalWarning on Node 22. It is noise in a hook, so drop just that one. */
async function sqlite(): Promise<typeof import('node:sqlite')> {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes('SQLite')) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqliteModule = await import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

export function auditPath(belaydHome: string): string {
  return path.join(belaydHome, 'audit.db');
}

export class AuditLog {
  private constructor(readonly db: DatabaseSync) {}

  static async open(belaydHome: string, opts: { readOnly?: boolean } = {}): Promise<AuditLog> {
    const { DatabaseSync } = await sqlite();
    const file = auditPath(belaydHome);
    if (!opts.readOnly) ensurePrivateDir(belaydHome);
    const db = new DatabaseSync(file, opts.readOnly ? { readOnly: true } : {});
    db.exec('PRAGMA busy_timeout = 3000;');
    if (!opts.readOnly) {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
      db.exec(SCHEMA);
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // not fatal
      }
    }
    return new AuditLog(db);
  }

  static exists(belaydHome: string): boolean {
    return fs.existsSync(auditPath(belaydHome));
  }

  close(): void {
    this.db.close();
  }

  /** Appends one event. `pre` events get the next step number in their session. */
  append(event: AuditEvent): StoredEvent {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const last = this.db.prepare('SELECT hash FROM events ORDER BY seq DESC LIMIT 1').get() as
        { hash: string } | undefined;
      const prevHash = last?.hash ?? this.anchor();
      let step: number;
      if (event.phase === 'pre') {
        const row = this.db
          .prepare(
            `SELECT COALESCE(MAX(step), 0) AS n FROM events WHERE session = ? AND phase = 'pre'`,
          )
          .get(event.session) as { n: number };
        step = row.n + 1;
      } else {
        const row = event.toolUseId
          ? (this.db
              .prepare(
                `SELECT step FROM events WHERE session = ? AND tool_use_id = ? AND phase = 'pre' ORDER BY seq DESC LIMIT 1`,
              )
              .get(event.session, event.toolUseId) as { step: number } | undefined)
          : undefined;
        step = row?.step ?? 0;
      }
      const values = toRow(event, step);
      const hash = hashRow(prevHash, values);
      const info = this.db
        .prepare(
          `INSERT INTO events (${COLUMNS.join(', ')}, prev_hash, hash) VALUES (${COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
        )
        .run(...values, prevHash, hash);
      this.db.exec('COMMIT');
      return { ...event, seq: Number(info.lastInsertRowid), step, prevHash, hash };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  events(
    filter: { session?: string; workspace?: string; limit?: number; sinceSeq?: number } = {},
  ): StoredEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.session) {
      where.push('session = ?');
      args.push(filter.session);
    }
    if (filter.workspace) {
      where.push('workspace = ?');
      args.push(filter.workspace);
    }
    if (filter.sinceSeq !== undefined) {
      where.push('seq > ?');
      args.push(filter.sinceSeq);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = filter.limit ? `LIMIT ${Math.max(1, Math.floor(filter.limit))}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT * FROM events ${clause} ORDER BY seq DESC ${limit}) ORDER BY seq ASC`,
      )
      .all(...args) as Record<string, unknown>[];
    return rows.map(fromRow);
  }

  sessions(filter: { workspace?: string; limit?: number } = {}): SessionSummary[] {
    const where = filter.workspace ? 'WHERE workspace = ?' : '';
    const args = filter.workspace ? [filter.workspace] : [];
    const limit = filter.limit ? `LIMIT ${Math.max(1, Math.floor(filter.limit))}` : '';
    return this.db
      .prepare(
        `SELECT session, agent, workspace, MIN(at) AS started, MAX(at) AS last,
                SUM(phase = 'pre') AS steps,
                SUM(phase = 'pre' AND decision = 'deny') AS denied,
                SUM(phase = 'pre' AND verdict = 'ask') AS asked,
                MAX(seq) AS last_seq
         FROM events ${where} GROUP BY session ORDER BY last_seq DESC ${limit}`,
      )
      .all(...args) as unknown as SessionSummary[];
  }

  /** Resolves a full or shortened session id, or the latest session in a workspace. */
  findSession(idOrPrefix: string | undefined, workspace: string | undefined): string | undefined {
    if (idOrPrefix) {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT session FROM events WHERE session = ? OR session LIKE ? OR session LIKE ? LIMIT 2`,
        )
        .all(idOrPrefix, `${idOrPrefix}%`, `%:${idOrPrefix}%`) as { session: string }[];
      return rows.length === 1
        ? rows[0]!.session
        : rows.find((r) => r.session === idOrPrefix)?.session;
    }
    const row = this.db
      .prepare(
        `SELECT session FROM events ${workspace ? 'WHERE workspace = ?' : ''} ORDER BY seq DESC LIMIT 1`,
      )
      .get(...(workspace ? [workspace] : [])) as { session: string } | undefined;
    return row?.session;
  }

  /** Checks every hash. Returns the first broken row, if any. */
  verify(): { ok: boolean; checked: number; brokenAt?: number; problem?: string } {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY seq ASC').all() as Record<
      string,
      unknown
    >[];
    let prev = this.anchor();
    for (const raw of rows) {
      const e = fromRow(raw);
      if (e.prevHash !== prev)
        return {
          ok: false,
          checked: rows.length,
          brokenAt: e.seq,
          problem: 'chain broken (a row was removed or reordered)',
        };
      if (hashRow(e.prevHash, toRow(e, e.step)) !== e.hash) {
        return { ok: false, checked: rows.length, brokenAt: e.seq, problem: 'row content changed' };
      }
      prev = e.hash;
    }
    return { ok: true, checked: rows.length };
  }

  /** Removes events older than `before`. The only way rows leave the log. */
  gc(before: number): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const keep = this.db
        .prepare('SELECT prev_hash FROM events WHERE at >= ? ORDER BY seq ASC LIMIT 1')
        .get(before) as { prev_hash: string } | undefined;
      const count = (
        this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE at < ?').get(before) as {
          n: number;
        }
      ).n;
      if (count > 0) {
        this.db.exec('DROP TRIGGER events_append_only_delete');
        this.db.prepare('DELETE FROM events WHERE at < ?').run(before);
        this.db.exec(SCHEMA);
        const anchor =
          keep?.prev_hash ??
          (
            this.db.prepare('SELECT hash FROM events ORDER BY seq DESC LIMIT 1').get() as
              { hash: string } | undefined
          )?.hash ??
          '';
        this.db
          .prepare(
            `INSERT INTO meta (key, value) VALUES ('anchor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(anchor);
      }
      this.db.exec('COMMIT');
      return count;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private anchor(): string {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'anchor'`).get() as
      { value: string } | undefined;
    return row?.value ?? '';
  }
}

export interface SessionSummary {
  session: string;
  agent: string;
  workspace: string;
  started: number;
  last: number;
  steps: number;
  denied: number;
  asked: number;
}

function toRow(e: AuditEvent, step: number): (string | number | null)[] {
  return [
    e.session,
    step,
    e.phase,
    e.at,
    e.agent,
    e.workspace,
    e.cwd ?? null,
    e.tool ?? null,
    e.toolUseId ?? null,
    e.kind ?? null,
    e.label ?? null,
    e.input ?? null,
    e.verdict ?? null,
    e.decision ?? null,
    e.outcome ?? null,
    e.reason ?? null,
    e.ruleId ?? null,
    e.answeredBy ?? null,
    e.snapshot ?? null,
    e.durationMs ?? null,
  ];
}

function fromRow(r: Record<string, unknown>): StoredEvent {
  const s = (k: string) => (r[k] === null || r[k] === undefined ? undefined : String(r[k]));
  return {
    seq: Number(r.seq),
    step: Number(r.step),
    session: String(r.session),
    phase: String(r.phase) as AuditEvent['phase'],
    at: Number(r.at),
    agent: String(r.agent),
    workspace: String(r.workspace),
    cwd: s('cwd'),
    tool: s('tool'),
    toolUseId: s('tool_use_id'),
    kind: s('kind'),
    label: s('label'),
    input: s('input'),
    verdict: s('verdict'),
    decision: s('decision'),
    outcome: s('outcome'),
    reason: s('reason'),
    ruleId: s('rule_id'),
    answeredBy: s('answered_by'),
    snapshot: s('snapshot'),
    durationMs: r.duration_ms === null ? undefined : Number(r.duration_ms),
    prevHash: String(r.prev_hash),
    hash: String(r.hash),
  };
}

function hashRow(prevHash: string, values: (string | number | null)[]): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([prevHash, ...values]))
    .digest('hex');
}
