import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/db.js';
import { maybeStartGc, pruneSnapshots } from '../../src/snapshots/retention.js';
import { Shadow } from '../../src/snapshots/shadow.js';

let dir: string;
let home: string;
let ws: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-retention-')));
  home = path.join(dir, 'bh');
  ws = path.join(dir, 'project');
  fs.mkdirSync(ws, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: ws });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Makes everything under `p` look `hours` old, as git and the pruner judge age by mtime. */
function age(p: string, hours: number): void {
  const t = new Date(Date.now() - hours * 3_600_000);
  if (fs.statSync(p).isFile()) return fs.utimesSync(p, t, t);
  const walk = (q: string) => {
    for (const e of fs.readdirSync(q, { withFileTypes: true })) {
      const r = path.join(q, e.name);
      if (e.isDirectory()) walk(r);
      fs.utimesSync(r, t, t);
    }
  };
  walk(p);
  fs.utimesSync(p, t, t);
}

function snapshot(shadow: Shadow, content: string): string {
  fs.writeFileSync(path.join(ws, 'data.txt'), content);
  return shadow.snapshotAll().tree;
}

const hasObject = (shadow: Shadow, id: string) => {
  try {
    execFileSync('git', ['--git-dir', shadow.dir, 'cat-file', '-e', id], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('pruneSnapshots', () => {
  it('keeps what recent steps need and lets go of the rest', async () => {
    const shadow = new Shadow(home, ws);
    shadow.ensure();
    const old = snapshot(shadow, 'old version '.repeat(1000));
    const recent = snapshot(shadow, 'recent version');
    const db = await AuditLog.open(home);
    const day = 86_400_000;
    for (const [tree, at] of [
      [old, Date.now() - 40 * day],
      [recent, Date.now() - day],
    ] as const)
      db.append({
        session: 's',
        phase: 'pre',
        at,
        agent: 'claude-code',
        workspace: ws,
        snapshot: JSON.stringify({ tree }),
      });
    age(shadow.dir, 2);

    pruneSnapshots(home, db, 30 * day);
    db.close();
    expect(hasObject(shadow, recent)).toBe(true);
    expect(hasObject(shadow, old)).toBe(false);
  });

  it('never deletes a snapshot taken in the last hour, even if nothing needs it yet', async () => {
    const shadow = new Shadow(home, ws);
    shadow.ensure();
    const fresh = snapshot(shadow, 'just now');
    const db = await AuditLog.open(home);
    pruneSnapshots(home, db, 86_400_000);
    db.close();
    expect(hasObject(shadow, fresh)).toBe(true);
  });

  it('removes the store of a project with nothing recent', async () => {
    const shadow = new Shadow(home, ws);
    shadow.ensure();
    snapshot(shadow, 'x');
    const db = await AuditLog.open(home);
    db.append({
      session: 's',
      phase: 'pre',
      at: Date.now() - 90 * 86_400_000,
      agent: 'claude-code',
      workspace: ws,
    });
    age(shadow.dir, 2);
    const r = pruneSnapshots(home, db, 30 * 86_400_000);
    db.close();
    expect(r.removed).toBe(1);
    expect(fs.existsSync(shadow.dir)).toBe(false);
  });
});

describe('maybeStartGc', () => {
  it('starts the clock on the first run, then runs at most once a day', () => {
    fs.mkdirSync(home, { recursive: true });
    const runs: string[][] = [];
    const run = (args: string[]) => runs.push(args);
    maybeStartGc(home, 30, run);
    maybeStartGc(home, 30, run);
    expect(runs).toEqual([]);
    age(path.join(home, 'gc.stamp'), 25);
    maybeStartGc(home, 14, run);
    maybeStartGc(home, 14, run);
    expect(runs).toEqual([['gc', '--snapshots-only', '--older-than', '14d', '--quiet']]);
  });
});
