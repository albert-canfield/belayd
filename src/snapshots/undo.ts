import type { StoredEvent } from '../audit/db.js';
import { Shadow, type Change } from './shadow.js';

export interface SnapRef {
  tree: string;
  /** For an undo: the snapshot right after it, so a redo can tell what changed since. */
  after?: string;
  paths?: string[];
  /** Files too big to capture. Undo cannot restore them. */
  skipped?: string[];
  /** After a step: the files its command says it writes (relative), for telling agents apart. */
  writes?: string[];
}

export interface StepChanges {
  step: number;
  session: string;
  /** When the step started and ended, epoch ms. */
  start: number;
  end: number;
  label: string;
  tool: string | undefined;
  pre: SnapRef;
  post: SnapRef;
  changes: Change[];
  /** Files another agent may also have changed while this step ran. */
  shared?: { path: string; sessions: string[] }[];
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
  /** Files another agent may also have changed at the same time, left alone without --force. */
  shared: { path: string; sessions: string[]; step: number }[];
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
      out.push({
        step: e.step,
        session: e.session,
        start: e.at,
        end: posts.get(e.toolUseId)?.at ?? e.at,
        label: e.label ?? '',
        tool: e.tool,
        pre,
        post,
        changes,
      });
    }
  }
  return out;
}

/**
 * Several agents can work in one project at once. A step's before and after snapshots
 * then also hold what the others wrote in between, so each changed file is checked
 * against the other sessions' steps that ran at the same time:
 *
 * - nobody else changed it: it is this step's
 * - this step's command says it writes the file and theirs does not: it is this step's
 * - their command says so and this step's does not: it is theirs, and left out
 * - otherwise both may have written it: it stays, marked shared, and undo leaves it
 *   alone unless forced
 */
export function withoutOtherAgents(mine: StepChanges[], others: StepChanges[]): StepChanges[] {
  return mine
    .map((s) => {
      const overlapping = others.filter(
        (o) => o.session !== s.session && o.start <= s.end && o.end >= s.start,
      );
      if (overlapping.length === 0) return s;
      const own = new Set(s.post.writes ?? []);
      const changes: Change[] = [];
      const shared: { path: string; sessions: string[] }[] = [];
      for (const c of s.changes) {
        const claimants = overlapping.filter((o) => o.changes.some((x) => x.path === c.path));
        if (claimants.length === 0) {
          changes.push(c);
          continue;
        }
        const mineSaysSo = own.has(c.path);
        const theirsSaysSo = claimants.some((o) => (o.post.writes ?? []).includes(c.path));
        if (mineSaysSo && !theirsSaysSo) changes.push(c);
        else if (!mineSaysSo && theirsSaysSo) continue;
        else {
          changes.push(c);
          shared.push({ path: c.path, sessions: [...new Set(claimants.map((o) => o.session))] });
        }
      }
      return { ...s, changes, ...(shared.length > 0 ? { shared } : {}) };
    })
    .filter((s) => s.changes.length > 0);
}

/** The steps of other sessions in the same project that ran during `mine`. */
export function concurrentSteps(
  workspaceEvents: StoredEvent[],
  mine: StepChanges[],
  shadow: Shadow,
): StepChanges[] {
  if (mine.length === 0) return [];
  const session = mine[0]!.session;
  const from = Math.min(...mine.map((s) => s.start));
  const to = Math.max(...mine.map((s) => s.end));
  const others = workspaceEvents.filter(
    (e) => e.session !== session && e.at >= from - 3_600_000 && e.at <= to + 3_600_000,
  );
  return stepChanges(others, shadow);
}

export function planUndo(
  shadow: Shadow,
  all: StepChanges[],
  steps: Set<number>,
  opts: { includeShared?: boolean } = {},
): UndoPlan {
  const chosen = all.filter((s) => steps.has(s.step)).sort((a, b) => a.step - b.step);
  const byPath = new Map<string, PlannedFile & { finalTree: string }>();
  const shared: UndoPlan['shared'] = [];
  for (const s of chosen) {
    for (const c of s.changes) {
      const other = s.shared?.find((x) => x.path === c.path);
      if (other && !opts.includeShared) {
        if (!shared.some((x) => x.path === c.path)) shared.push({ ...other, step: s.step });
        continue;
      }
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
  return {
    steps: chosen.map((s) => s.step),
    files: files.filter((f) => !shared.some((x) => x.path === f.path)),
    conflicts: conflicts.filter((c) => !shared.some((x) => x.path === c.path)),
    unchanged,
    shared,
  };
}

/**
 * Applies a plan. Returns the snapshots taken just before and just after (so the undo
 * can be undone, and the redo can check nothing changed in between), and the files it
 * left alone because a link or folder now stands in the way.
 */
export function applyUndo(shadow: Shadow, plan: UndoPlan): { before: SnapRef; skipped: string[] } {
  const before = shadow.snapshotAll();
  const byTree = new Map<string, string[]>();
  for (const f of plan.files) byTree.set(f.tree, [...(byTree.get(f.tree) ?? []), f.path]);
  const skipped: string[] = [];
  for (const [tree, files] of byTree) skipped.push(...shadow.restore(tree, files));
  const after = shadow.snapshotAll();
  return { before: { tree: before.tree, after: after.tree }, skipped };
}

/**
 * The plan for reversing an undo: put back the files as they were just before it. A
 * file changed since the undo is a conflict, like a file changed after an undone step.
 */
export function planRedo(shadow: Shadow, undone: SnapRef, files: string[]): UndoPlan {
  const plan: UndoPlan = { steps: [], files: [], conflicts: [], unchanged: [], shared: [] };
  for (const f of files) {
    const target = shadow.blobAt(undone.tree, f);
    const current = shadow.currentBlob(f);
    if (current === target) {
      plan.unchanged.push(f);
      continue;
    }
    // An undo recorded before belayd kept the after snapshot cannot be checked.
    if (!undone.after || current !== shadow.blobAt(undone.after, f))
      plan.conflicts.push({ path: f, lastStep: 0 });
    plan.files.push({
      path: f,
      action: target ? 'restore' : 'delete',
      tree: undone.tree,
      firstStep: 0,
      lastStep: 0,
    });
  }
  return plan;
}
