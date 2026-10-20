import fs from 'node:fs';
import path from 'node:path';
import { liveSessions } from '../audit/live.js';
import { findAgent } from '../agents/registry.js';
import { untrustedGit } from '../util/git.js';
import { canonicalPath } from '../util/paths.js';
import type { Subject } from './subjects.js';

/**
 * Two agents in one working tree: one runs `git checkout -- .`, `git stash` or `git add
 * -A && git commit`, or rewrites a file, while the other still has uncommitted changes
 * there. This finds those changes, so the policy can ask first (rule
 * ask-other-agents-work). Agents only know their own work; belayd sees every agent's
 * tool calls in the project (src/audit/live.ts).
 *
 * A file belongs to the agent that last said it would change it, in a session with a tool
 * call in the last 30 minutes. Only what the command itself names counts, never what a
 * snapshot saw change: with two agents working at once, a snapshot cannot tell whose
 * change it saw. Changes that are committed are no longer at risk, and neither are files
 * Git ignores.
 */

export interface ClobberContext {
  belaydHome: string;
  workspace: string;
  /** This agent's session key (`agent:session-id`). */
  session: string;
  cwd: string;
  now?: number;
}

interface Owner {
  session: string;
  agent: string;
  at: number;
}

/** What Git reports for a file: index (x) and working tree (y) status letters. */
interface FileStatus {
  x: string;
  y: string;
}

interface GitOp {
  /** How the detail describes it. */
  does: string;
  /** Pathspecs, absolute; `all` for the whole repository. */
  scope: 'all' | string[];
  staged: boolean;
  modified: boolean;
  untracked: boolean;
  ignored: boolean;
}

/** A check to pass to `evaluate`; it reads nothing until a call could clobber something. */
export function makeClobberCheck(ctx: ClobberContext): (s: Subject) => string | undefined {
  let owners: Map<string, Owner> | undefined;
  let status: Map<string, FileStatus> | null | undefined;
  return (s) => {
    const op = s.kind === 'shell' && s.program === 'git' ? gitOp(s) : undefined;
    const writes = op ? [] : s.writes;
    if (!op && writes.length === 0) return undefined;
    owners ??= othersFiles(ctx);
    if (owners.size === 0) return undefined;
    // A write that touches none of their files needs no `git status`.
    const targets = writes.map(canonicalPath);
    const theirs = op ? owners : overlapping(targets, owners);
    if (theirs.size === 0) return undefined;
    if (status === undefined) status = gitStatus(ctx.cwd);
    const hits = op ? fromGitOp(op, theirs, status) : uncommitted(theirs, status);
    return hits.length > 0 ? describe(op ? op.does : 'overwrite', hits, ctx) : undefined;
  };
}

/** Their files that a write to `targets` would change: the file itself, or one inside it. */
function overlapping(targets: string[], owners: Map<string, Owner>): Map<string, Owner> {
  const out = new Map<string, Owner>();
  for (const [file, owner] of owners) {
    if (targets.some((t) => file === t || file.startsWith(`${t}/`))) out.set(file, owner);
  }
  return out;
}

/** The newest writer of each file in this project, when that is another live session. */
function othersFiles(ctx: ClobberContext): Map<string, Owner> {
  const latest = new Map<string, Owner>();
  for (const s of liveSessions(ctx.belaydHome, ctx.workspace, ctx.now)) {
    for (const [file, at] of s.writes) {
      const key = canonicalPath(file);
      const seen = latest.get(key);
      if (!seen || at > seen.at) latest.set(key, { session: s.session, agent: s.agent, at });
    }
  }
  for (const [file, owner] of latest) if (owner.session === ctx.session) latest.delete(file);
  return latest;
}

/** Uncommitted files of the repository around `cwd`, by absolute path; null outside Git. */
function gitStatus(cwd: string): Map<string, FileStatus> | null {
  try {
    const top = canonicalPath(untrustedGit(['rev-parse', '--show-toplevel'], { cwd }).trim());
    const out = untrustedGit(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
      { cwd: top },
    );
    const files = new Map<string, FileStatus>();
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!;
      if (entry.length < 4) continue;
      const x = entry[0]!;
      const y = entry[1]!;
      files.set(path.join(top, entry.slice(3)), { x, y });
      // A rename is followed by the name it had before.
      if (x === 'R' || x === 'C') i++;
    }
    return files;
  } catch {
    return null;
  }
}

function uncommitted(
  owners: Map<string, Owner>,
  status: Map<string, FileStatus> | null,
): [string, Owner][] {
  const hits: [string, Owner][] = [];
  for (const [file, owner] of owners) {
    // Outside Git there is no telling whether it is committed: count it.
    const st = status === null ? { x: 'M', y: 'M' } : status.get(file);
    if (st && st.x !== '!') hits.push([file, owner]);
  }
  return hits;
}

function fromGitOp(
  op: GitOp,
  owners: Map<string, Owner>,
  status: Map<string, FileStatus> | null,
): [string, Owner][] {
  // Outside a repository a git command touches nothing of theirs.
  if (status === null) return [];
  const hits: [string, Owner][] = [];
  for (const [file, owner] of owners) {
    const st = status.get(file);
    if (!st) continue;
    const untracked = st.x === '?';
    const ignored = st.x === '!';
    const staged = !untracked && !ignored && st.x !== ' ';
    const modified = !untracked && !ignored && st.y !== ' ';
    const touched =
      (op.staged && staged) ||
      (op.modified && modified) ||
      (op.untracked && untracked) ||
      (op.ignored && ignored);
    if (!touched) continue;
    if (op.scope !== 'all' && !op.scope.some((p) => file === p || file.startsWith(`${p}/`)))
      continue;
    hits.push([file, owner]);
  }
  return hits;
}

const has = (s: Subject, ...flags: string[]) => flags.some((f) => s.args.includes(f));

/** What a git command does to uncommitted work, or undefined when it leaves it alone. */
function gitOp(s: Subject): GitOp | undefined {
  const sub = s.positionals[0];
  // Pathspecs, as absolute paths. One we cannot pin down covers everything.
  const vague = s.dynamic || s.unresolved || s.positionals.slice(1).some((p) => /[*?[\]]/.test(p));
  const named = s.paths.map(canonicalPath);
  const existing = named.filter((p) => fs.existsSync(p));
  const pathspecs = (): 'all' | string[] => (vague ? 'all' : named);
  const op = (does: string, scope: 'all' | string[], kinds: Partial<GitOp>): GitOp => ({
    does,
    scope,
    staged: false,
    modified: false,
    untracked: false,
    ignored: false,
    ...kinds,
  });
  const tracked = { staged: true, modified: true };
  switch (sub) {
    case 'reset':
      return has(s, '--hard') ? op('throw away', 'all', tracked) : undefined;
    case 'checkout': {
      if (has(s, '-f', '--force')) return op('throw away', 'all', tracked);
      if (has(s, '--') || existing.length > 0 || vague)
        return op('throw away', has(s, '--') ? pathspecs() : existing, tracked);
      // `git checkout other-branch`: their changes move with it, and their next commit
      // lands on a branch they did not choose.
      return op('carry onto another branch', 'all', { ...tracked, untracked: true });
    }
    case 'switch':
      return has(s, '-f', '--force', '--discard-changes')
        ? op('throw away', 'all', tracked)
        : op('carry onto another branch', 'all', { ...tracked, untracked: true });
    case 'restore': {
      const staged = has(s, '--staged', '-S');
      const worktree = has(s, '--worktree', '-W') || !staged;
      if (!worktree) return undefined;
      return op('throw away', pathspecs(), { modified: true, staged });
    }
    case 'clean':
      if (has(s, '-n', '--dry-run') || !has(s, '-f', '--force')) return undefined;
      return op('delete', pathspecs().length === 0 ? 'all' : pathspecs(), {
        untracked: !has(s, '-X'),
        ignored: has(s, '-x', '-X'),
      });
    case 'stash': {
      const verb = s.positionals[1];
      if (verb !== undefined && verb !== 'push' && verb !== 'save') return undefined;
      const spec = has(s, '--') ? pathspecs() : 'all';
      return op('stash', spec === 'all' || spec.length === 0 ? 'all' : spec, {
        ...tracked,
        untracked: has(s, '-u', '--include-untracked', '-a', '--all'),
        ignored: has(s, '-a', '--all'),
      });
    }
    case 'add': {
      if (has(s, '-n', '--dry-run')) return undefined;
      const all = has(s, '-A', '--all');
      const scope = all ? 'all' : pathspecs();
      if (scope !== 'all' && scope.length === 0 && !has(s, '-u', '--update')) return undefined;
      return op('sweep into a commit', scope !== 'all' && scope.length === 0 ? 'all' : scope, {
        modified: true,
        untracked: !has(s, '-u', '--update'),
      });
    }
    case 'commit':
      if (has(s, '-a', '--all')) return op('sweep into a commit', 'all', tracked);
      if (existing.length > 0) return op('sweep into a commit', existing, tracked);
      // Plain `git commit` takes whatever is staged, theirs included.
      return op('sweep into a commit', 'all', { staged: true });
    default:
      return undefined;
  }
}

function describe(does: string, hits: [string, Owner][], ctx: ClobberContext): string {
  const bySession = new Map<string, { owner: Owner; files: string[] }>();
  for (const [file, owner] of hits) {
    const entry = bySession.get(owner.session) ?? { owner, files: [] };
    entry.files.push(file);
    if (owner.at > entry.owner.at) entry.owner = owner;
    bySession.set(owner.session, entry);
  }
  const now = ctx.now ?? Date.now();
  const parts = [...bySession.values()].map(({ owner, files }) => {
    const name = findAgent(owner.agent)?.name ?? owner.agent;
    const shown = files
      .sort()
      .slice(0, 3)
      .map((f) => path.relative(ctx.workspace, f) || f);
    const more = files.length > 3 ? ` and ${files.length - 3} more` : '';
    const minutes = Math.max(0, Math.round((now - owner.at) / 60_000));
    return `${name} changed ${shown.join(', ')}${more} ${minutes === 0 ? 'just now' : `${minutes} min ago`}`;
  });
  return `this would ${does} uncommitted work: ${parts.join('; ')}`;
}
