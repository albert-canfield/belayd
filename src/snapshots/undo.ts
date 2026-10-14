import type { StoredEvent } from '../audit/db.js';
import { Shadow, type Change } from './shadow.js';

export interface SnapRef {
  tree: string;
  paths?: string[];
  /** Files too big to capture. Undo cannot restore them. */
  skipped?: string[];
}

export interface StepChanges {
  step: number;
  label: string;
  tool: string | undefined;
  pre: SnapRef;
  post: SnapRef;
  changes: Change[];
}

export interface PlannedFile {
  path: string;
  /** Put back the old content, or delete a file the steps created. */
  action: 'restore' | 'delete';
  /** Snapshot holding the content to restore. */
  tree: string;
  firstStep: number;
  lastStep: number;
  added?: number;
  removed?: number;
}

export interface UndoPlan {
  steps: number[];
  files: PlannedFile[];
  /** Files changed again after the steps being undone. Undoing would lose that work. */
  conflicts: { path: string; lastStep: number }[];
  /** Files already back to how they were. */
  unchanged: string[];
}

export function parseSnapshot(value: string | undefined): SnapRef | undefined {
  if (!value) return undefined;
  try {
    const v = JSON.parse(value) as SnapRef;
    return typeof v.tree === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** For every step that has before and after snapshots, the files it changed. */
export function stepChanges(events: StoredEvent[], shadow: Shadow): StepChanges[] {
  const posts = new Map<string, StoredEvent>();
  for (const e of events) if (e.phase === 'post' && e.toolUseId) posts.set(e.toolUseId, e);
  const out: StepChanges[] = [];
  for (const e of events) {
    if (e.phase !== 'pre' || !e.toolUseId) continue;
    const pre = parseSnapshot(e.snapshot);
    const post = parseSnapshot(posts.get(e.toolUseId)?.snapshot);
    if (!pre || !post) continue;
    let changes: Change[];
    try {
      changes = shadow.changes(pre.tree, post.tree, pre.paths);
    } catch {
      continue; // snapshot objects missing, for example after the shadow repo was removed
    }
    if (changes.length > 0) {
      out.push({ step: e.step, label: e.label ?? '', tool: e.tool, pre, post, changes });
    }
  }
  return out;
}

export function planUndo(shadow: Shadow, all: StepChanges[], steps: Set<number>): UndoPlan {
  const chosen = all.filter((s) => steps.has(s.step)).sort((a, b) => a.step - b.step);
  const byPath = new Map<string, PlannedFile & { finalTree: string }>();
  for (const s of chosen) {
    for (const c of s.changes) {
      const existing = byPath.get(c.path);
      if (existing) {
        existing.finalTree = s.post.tree;
        existing.lastStep = s.step;
      } else {
        byPath.set(c.path, {
          path: c.path,
          action: 'restore',
          tree: s.pre.tree,
          firstStep: s.step,
          lastStep: s.step,
          finalTree: s.post.tree,
          ...(c.added !== undefined ? { added: c.added } : {}),
          ...(c.removed !== undefined ? { removed: c.removed } : {}),
        });
      }
    }
  }

  const files: PlannedFile[] = [];
  const conflicts: UndoPlan['conflicts'] = [];
  const unchanged: string[] = [];
  for (const f of byPath.values()) {
    const target = shadow.blobAt(f.tree, f.path);
    const expected = shadow.blobAt(f.finalTree, f.path);
    const current = shadow.currentBlob(f.path);
    if (current === target) {
      unchanged.push(f.path);
      continue;
    }
    if (current !== expected) conflicts.push({ path: f.path, lastStep: f.lastStep });
    files.push({
      path: f.path,
      action: target ? 'restore' : 'delete',
      tree: f.tree,
      firstStep: f.firstStep,
      lastStep: f.lastStep,
      ...(f.added !== undefined ? { added: f.added } : {}),
      ...(f.removed !== undefined ? { removed: f.removed } : {}),
    });
  }
  return { steps: chosen.map((s) => s.step), files, conflicts, unchanged };
}

/** Applies a plan. Returns the snapshot taken just before, so the undo can be undone. */
export function applyUndo(shadow: Shadow, plan: UndoPlan): SnapRef {
  const before = shadow.snapshotAll();
  const byTree = new Map<string, string[]>();
  for (const f of plan.files) byTree.set(f.tree, [...(byTree.get(f.tree) ?? []), f.path]);
  for (const [tree, files] of byTree) shadow.restore(tree, files);
  shadow.snapshotAll();
  return { tree: before.tree };
}
