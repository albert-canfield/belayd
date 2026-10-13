import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeRequest,
  createRequest,
  decide,
  listPending,
  newId,
  readDecision,
  type ApprovalRequest,
} from '../../src/approval/store.js';

let home: string;
beforeEach(() => (home = fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-store-'))));
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: newId(),
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  agent: 'claude-code',
  workspace: '/work/app',
  cwd: '/work/app',
  label: 'git push --force-with-lease',
  kind: 'shell',
  reason: 'Force pushes',
  pid: process.pid,
  ...over,
});

describe('approval store', () => {
  it('lists pending requests oldest first', () => {
    const a = request({ createdAt: 2 });
    const b = request({ createdAt: 1 });
    createRequest(home, a);
    createRequest(home, b);
    expect(listPending(home).map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it('lets the first answer win', () => {
    const r = request();
    createRequest(home, r);
    expect(decide(home, r.id, 'deny', 'tty')).toBe(true);
    expect(decide(home, r.id, 'allow', 'web')).toBe(false);
    expect(readDecision(home, r.id)?.decision).toBe('deny');
    expect(listPending(home)).toEqual([]);
  });

  it('refuses answers for unknown or malformed ids', () => {
    expect(decide(home, 'nope', 'allow', 'cli')).toBe(false);
    expect(decide(home, '../../etc/passwd', 'allow', 'cli')).toBe(false);
  });

  it('drops requests whose hook process is gone', () => {
    createRequest(home, request({ pid: 999_999_99 }));
    expect(listPending(home)).toEqual([]);
    expect(fs.readdirSync(path.join(home, 'approvals', 'pending'))).toEqual([]);
  });

  it('drops expired requests', () => {
    createRequest(home, request({ expiresAt: Date.now() - 60_000 }));
    expect(listPending(home)).toEqual([]);
  });

  it('cleans up after the hook is done', () => {
    const r = request();
    createRequest(home, r);
    decide(home, r.id, 'allow', 'web');
    closeRequest(home, r.id);
    expect(readDecision(home, r.id)).toBeUndefined();
  });
});
