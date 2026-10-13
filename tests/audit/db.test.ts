import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, type AuditEvent } from '../../src/audit/db.js';
import { summarizeInput } from '../../src/audit/record.js';

let home: string;
let log: AuditLog;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-audit-'));
  log = await AuditLog.open(home);
});
afterEach(() => {
  log.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  session: 'claude-code:s1',
  phase: 'pre',
  at: Date.now(),
  agent: 'claude-code',
  workspace: '/work/app',
  tool: 'Bash',
  label: 'npm test',
  verdict: 'pass',
  decision: 'pass',
  ...over,
});

describe('audit log', () => {
  it('numbers steps per session and links post events to their step', () => {
    log.append(event({ toolUseId: 'a' }));
    log.append(event({ toolUseId: 'b', session: 'claude-code:s2' }));
    log.append(event({ toolUseId: 'c' }));
    const post = log.append(event({ phase: 'post', toolUseId: 'c', outcome: 'ran' }));
    expect(post.step).toBe(2);
    expect(log.events({ session: 'claude-code:s1' }).map((e) => e.step)).toEqual([1, 2, 2]);
  });

  it('refuses updates and deletes', () => {
    log.append(event());
    expect(() => log.db.exec(`UPDATE events SET label = 'x'`)).toThrow(/append-only/);
    expect(() => log.db.exec('DELETE FROM events')).toThrow(/append-only/);
  });

  it('detects a changed row even when the trigger is removed first', () => {
    log.append(event({ label: 'rm -rf ~', decision: 'deny' }));
    log.append(event());
    expect(log.verify().ok).toBe(true);
    log.db.exec('DROP TRIGGER events_append_only_update');
    log.db.exec(`UPDATE events SET decision = 'allow' WHERE seq = 1`);
    const r = log.verify();
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(1);
  });

  it('detects a removed row', () => {
    log.append(event());
    log.append(event());
    log.append(event());
    log.db.exec('DROP TRIGGER events_append_only_delete');
    log.db.exec('DELETE FROM events WHERE seq = 2');
    expect(log.verify()).toMatchObject({ ok: false, brokenAt: 3 });
  });

  it('gc removes old events and the rest still verifies', () => {
    log.append(event({ at: Date.now() - 40 * 86_400_000 }));
    log.append(event({ at: Date.now() - 35 * 86_400_000 }));
    log.append(event());
    expect(log.gc(Date.now() - 30 * 86_400_000)).toBe(2);
    expect(log.events()).toHaveLength(1);
    expect(log.verify().ok).toBe(true);
    log.append(event());
    expect(log.verify().ok).toBe(true);
  });

  it('summarises sessions and finds them by prefix', () => {
    log.append(event({ session: 'claude-code:abc123', decision: 'deny', verdict: 'deny' }));
    log.append(event({ session: 'claude-code:abc123', verdict: 'ask', decision: 'ask' }));
    const [s] = log.sessions();
    expect(s).toMatchObject({ session: 'claude-code:abc123', steps: 2, denied: 1, asked: 1 });
    expect(log.findSession('abc', undefined)).toBe('claude-code:abc123');
    expect(log.findSession(undefined, '/work/app')).toBe('claude-code:abc123');
  });
});

describe('input summaries', () => {
  it('replaces large values with their size and hash', () => {
    const big = 'x'.repeat(5000);
    const out = JSON.parse(summarizeInput({ file_path: '/a', content: big }));
    expect(out.file_path).toBe('/a');
    expect(out.content).toMatch(/^\[5000 chars, sha256 [a-f0-9]{12}\]$/);
  });
});
