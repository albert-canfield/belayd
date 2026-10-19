import fs from 'node:fs';
import path from 'node:path';
import type { AuditLog } from '../audit/db.js';
import { dirBytes, Shadow } from './shadow.js';
import { parseSnapshot } from './undo.js';

export interface PruneResult {
  before: number;
  after: number;
  /** Shadow repositories with nothing left to keep, deleted whole. */
  removed: number;
}

/**
 * Deletes snapshots that no audit event from the last `keepMs` needs. Undo for older
 * steps then says the snapshot is gone; the audit log itself is not touched. Without
 * this the snapshot store only ever grows (node9 removed its undo after one machine's
 * store reached 378 GB).
 */
export function pruneSnapshots(home: string, db: AuditLog, keepMs: number): PruneResult {
  const root = path.join(home, 'snapshots');
  const before = dirBytes(root);
  const cutoff = Date.now() - keepMs;
  const keep = new Map<string, Set<string>>();
  for (const e of db.events()) {
    if (e.at < cutoff || !e.snapshot) continue;
    const ref = parseSnapshot(e.snapshot);
    if (!ref) continue;
    let trees = keep.get(e.workspace);
    if (!trees) keep.set(e.workspace, (trees = new Set()));
    trees.add(ref.tree);
    if (ref.after) trees.add(ref.after);
  }

  const kept = new Set<string>();
  for (const [workspace, trees] of keep) {
    const shadow = new Shadow(home, workspace);
    if (!shadow.exists() || !fs.existsSync(shadow.workspace)) continue;
    kept.add(path.basename(shadow.dir));
    try {
      shadow.prune([...trees]);
    } catch {
      // a busy or damaged store is tried again next time
    }
  }

  let removed = 0;
  let dirs: fs.Dirent[] = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // no snapshots yet
  }
  for (const d of dirs) {
    if (!d.isDirectory() || kept.has(d.name)) continue;
    const dir = path.join(root, d.name);
    // Nothing recent needs it. A store touched in the last hour may belong to a step
    // whose audit event is still being written, so it waits for the next run.
    if (Date.now() - fs.statSync(dir).mtimeMs < Math.min(keepMs, 3_600_000)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed++;
  }
  return { before, after: dirBytes(root), removed };
}

const STAMP = 'gc.stamp';

/**
 * At most once a day, starts `belayd gc --snapshots-only` in the background. The first
 * run only starts the clock, so a brand-new setup (and every test sandbox) does nothing.
 */
export function maybeStartGc(home: string, keepDays: number, run: (args: string[]) => void): void {
  const stamp = path.join(home, STAMP);
  let last: number | undefined;
  try {
    last = fs.statSync(stamp).mtimeMs;
  } catch {
    // never ran
  }
  if (last !== undefined && Date.now() - last < 86_400_000) return;
  try {
    fs.writeFileSync(stamp, '');
  } catch {
    return;
  }
  if (last !== undefined)
    run(['gc', '--snapshots-only', '--older-than', `${keepDays}d`, '--quiet']);
}
