import path from 'node:path';
import { logError } from '../audit/record.js';
import type { CompiledPolicy } from '../policy/load.js';
import type { Action, ActionContext } from '../policy/types.js';
import { snapshotScope } from './scope.js';
import { Shadow } from './shadow.js';

/**
 * Agents started outside a project (in the home folder, or at /) would make the
 * "workspace" the whole disk. belayd does not snapshot those.
 */
export function tooBroad(workspace: string, home: string): boolean {
  const w = path.resolve(workspace);
  const h = path.resolve(home);
  return w === path.parse(w).root || w === h || h.startsWith(w + path.sep);
}

/**
 * Takes the snapshot an action needs and returns it as JSON for the audit log.
 * A failed snapshot never blocks the agent: it is logged and undo is simply not
 * available for that step. `onChanged` receives the absolute paths that changed since
 * the previous snapshot, which after a step is what that step wrote.
 */
export function capture(
  belaydHome: string,
  policy: CompiledPolicy,
  action: Action,
  ctx: ActionContext,
  opts: {
    onChanged?: (paths: string[]) => void;
    /** After a step: the absolute paths its command says it writes, kept to tell agents apart. */
    predicted?: string[];
    /** Epoch ms by which to give up on the snapshot, so the hook still answers in time. */
    deadline?: number;
  } = {},
): string | undefined {
  if (!policy.snapshots.enabled) return undefined;
  try {
    const scope = snapshotScope(action, ctx);
    if (scope.kind === 'none') return undefined;
    if (tooBroad(ctx.workspace, ctx.home)) return undefined;
    const shadow = new Shadow(belaydHome, ctx.workspace, {
      maxFileSize: policy.snapshots.maxFileSize,
      ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
    });
    const { changed, ...snap } =
      scope.kind === 'all' ? shadow.snapshotAll() : shadow.snapshotPaths(scope.paths);
    if (changed && opts.onChanged) opts.onChanged(changed.map((p) => path.join(ctx.workspace, p)));
    const writes = [
      ...new Set(
        (opts.predicted ?? [])
          .map((p) => path.relative(ctx.workspace, p))
          .filter((r) => r && !r.startsWith('..') && !path.isAbsolute(r)),
      ),
    ];
    return JSON.stringify(writes.length > 0 ? { ...snap, writes } : snap);
  } catch (err) {
    logError(belaydHome, `snapshot: ${(err as Error).message}`);
    return undefined;
  }
}
