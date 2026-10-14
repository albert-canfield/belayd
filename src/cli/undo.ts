import path from 'node:path';
import pc from 'picocolors';
import { AuditLog, type StoredEvent } from '../audit/db.js';
import { record } from '../audit/record.js';
import { Shadow } from '../snapshots/shadow.js';
import {
  applyUndo,
  parseSnapshot,
  planUndo,
  stepChanges,
  type UndoPlan,
} from '../snapshots/undo.js';
import { belaydHome, findWorkspace } from '../util/paths.js';

export interface UndoOptions {
  session?: string;
  wholeSession?: boolean;
  dryRun?: boolean;
  force?: boolean;
  diff?: boolean;
}

export async function undo(stepArg: string | undefined, opts: UndoOptions): Promise<number> {
  const home = belaydHome();
  const workspace = findWorkspace(process.cwd());
  if (!AuditLog.exists(home)) {
    console.log('Nothing to undo yet: belayd has not recorded any agent steps.');
    return 0;
  }
  const db = await AuditLog.open(home);
  try {
    const session = db.findSession(opts.session, opts.session ? undefined : workspace);
    if (!session) {
      console.error(
        opts.session
          ? `No session matches "${opts.session}".`
          : 'No agent sessions recorded for this project yet.',
      );
      return 1;
    }
    const events = db.events({ session });
    const sessionWorkspace = events[0]?.workspace ?? workspace;
    const shadow = new Shadow(home, sessionWorkspace);
    if (!shadow.exists()) {
      console.log('No snapshots for this project, so there is nothing to undo.');
      return 0;
    }
    const steps = stepChanges(events, shadow);
    if (steps.length === 0) {
      console.log(`No step in session ${short(session)} changed any files.`);
      return 0;
    }

    let wanted: number[];
    if (opts.wholeSession) wanted = steps.map((s) => s.step);
    else if (stepArg) {
      const parsed = parseSteps(stepArg);
      if (!parsed) {
        console.error(
          'Give a step number, a range or a list, for example: belayd undo 7, belayd undo 5-8, belayd undo 5,7',
        );
        return 64;
      }
      wanted = parsed;
    } else wanted = [steps[steps.length - 1]!.step];

    const missing = wanted.filter((n) => !steps.some((s) => s.step === n));
    if (missing.length > 0 && !opts.wholeSession) {
      console.error(
        `Step ${missing.join(', ')} did not change any files (or was not recorded). Steps with changes: ${steps.map((s) => s.step).join(', ')}`,
      );
      return 1;
    }

    const plan = planUndo(shadow, steps, new Set(wanted));
    printPlan(plan, steps, session, sessionWorkspace);

    if (plan.files.length === 0) {
      console.log(pc.green('\nNothing to do: those files are already back to how they were.'));
      return 0;
    }
    if (opts.diff) {
      for (const f of plan.files) {
        const current = shadow.snapshotPaths([f.path]).tree;
        console.log(pc.dim(shadow.diff(current, f.tree, [f.path])));
      }
    }
    if (plan.conflicts.length > 0 && !opts.force) {
      console.log('');
      for (const c of plan.conflicts) {
        console.log(pc.red(`✖ ${c.path} changed again after step ${c.lastStep}.`));
      }
      console.log(
        pc.dim(
          '  Undoing now would throw that newer work away. Undo the later steps first, or use --force.',
        ),
      );
      return 1;
    }
    if (opts.dryRun) {
      console.log(pc.dim('\nDry run: nothing changed.'));
      return 0;
    }

    const { before, skipped } = applyUndo(shadow, plan);
    await record(home, {
      session,
      phase: 'undo',
      at: Date.now(),
      agent: events[0]?.agent ?? 'cli',
      workspace: sessionWorkspace,
      tool: 'undo',
      label: `undo ${plan.steps.length === 1 ? `step ${plan.steps[0]}` : `steps ${plan.steps.join(', ')}`}`,
      input: JSON.stringify(plan.files.map((f) => f.path)),
      outcome: 'undo',
      snapshot: JSON.stringify(before),
    });
    const done = plan.files.length - skipped.length;
    console.log(
      pc.green(`\n✔ Undid ${done} file change${done === 1 ? '' : 's'}.`) +
        pc.dim('  Changed your mind? belayd redo'),
    );
    for (const f of skipped) {
      console.log(
        pc.yellow(
          `  left alone: ${f} (a folder on its path is now a link, belayd will not write through it)`,
        ),
      );
    }
    return skipped.length > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

/** Reverses the most recent undo in this project. */
export async function redo(): Promise<number> {
  const home = belaydHome();
  const workspace = findWorkspace(process.cwd());
  if (!AuditLog.exists(home)) {
    console.log('Nothing to redo.');
    return 0;
  }
  const db = await AuditLog.open(home);
  try {
    const events = db.events({ workspace }).filter((e) => e.phase === 'undo');
    const redone = new Set(events.filter((e) => e.outcome === 'redo').map((e) => e.reason));
    const last = [...events]
      .reverse()
      .find((e) => e.outcome === 'undo' && !redone.has(`redo of #${e.seq}`));
    if (!last) {
      console.log('Nothing to redo: no undo in this project yet.');
      return 0;
    }
    const before = parseSnapshot(last.snapshot);
    const files = JSON.parse(last.input ?? '[]') as string[];
    if (!before || files.length === 0) {
      console.log('That undo has no snapshot to go back to.');
      return 1;
    }
    const shadow = new Shadow(home, last.workspace);
    const plan: UndoPlan = {
      steps: [],
      files: files.map((f) => ({
        path: f,
        action: shadow.blobAt(before.tree, f) ? 'restore' : 'delete',
        tree: before.tree,
        firstStep: 0,
        lastStep: 0,
      })),
      conflicts: [],
      unchanged: [],
    };
    const snap = applyUndo(shadow, plan).before;
    await record(home, {
      session: last.session,
      phase: 'undo',
      at: Date.now(),
      agent: last.agent,
      workspace: last.workspace,
      tool: 'redo',
      label: `redo (${last.label})`,
      input: last.input,
      outcome: 'redo',
      reason: `redo of #${last.seq}`,
      snapshot: JSON.stringify(snap),
    });
    console.log(
      pc.green(
        `✔ Put back ${files.length} file${files.length === 1 ? '' : 's'} as they were before "${last.label}".`,
      ),
    );
    for (const f of files) console.log(pc.dim(`  ${f}`));
    return 0;
  } finally {
    db.close();
  }
}

function printPlan(
  plan: UndoPlan,
  steps: ReturnType<typeof stepChanges>,
  session: string,
  workspace: string,
): void {
  const label =
    plan.steps.length === 1 ? `step ${plan.steps[0]}` : `steps ${plan.steps.join(', ')}`;
  console.log(
    `${pc.bold(`Undo ${label}`)} ${pc.dim(`of session ${short(session)} in ${path.basename(workspace)}`)}`,
  );
  for (const s of steps.filter((x) => plan.steps.includes(x.step))) {
    const label = s.label.split(`${workspace}/`).join('');
    console.log(pc.dim(`  ${String(s.step).padStart(3)}  ${s.tool ?? ''}  ${oneLine(label)}`));
  }
  console.log('');
  for (const f of plan.files) {
    const counts = f.added !== undefined ? pc.dim(`  +${f.added} -${f.removed ?? 0}`) : '';
    const verb = f.action === 'delete' ? pc.yellow('delete ') : pc.cyan('restore');
    const note = f.action === 'delete' ? pc.dim('  (created by the agent)') : '';
    console.log(`  ${verb}  ${f.path}${counts}${note}`);
  }
  for (const u of plan.unchanged) console.log(pc.dim(`  ok       ${u}  (already as it was)`));
  const tooBig = new Set(
    steps
      .filter((x) => plan.steps.includes(x.step))
      .flatMap((x) => [...(x.pre.skipped ?? []), ...(x.post.skipped ?? [])]),
  );
  for (const f of tooBig) {
    console.log(pc.yellow(`  skip     ${f}  (too big to snapshot, see snapshots.maxFileSize)`));
  }
}

function parseSteps(arg: string): number[] | undefined {
  const out: number[] = [];
  for (const part of arg.split(',')) {
    const range = /^(\d+)-(\d+)$/.exec(part.trim());
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (b < a || b - a > 10_000) return undefined;
      for (let i = a; i <= b; i++) out.push(i);
    } else if (/^\d+$/.test(part.trim())) out.push(Number(part.trim()));
    else return undefined;
  }
  return out.length > 0 ? out : undefined;
}

function short(s: string): string {
  return (s.includes(':') ? s.slice(s.indexOf(':') + 1) : s).slice(0, 8);
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

export type { StoredEvent };
