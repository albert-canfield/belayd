import os from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';
import { findSecrets, loadEnvValues } from '../secrets/detect.js';
import { canonicalPath } from '../util/paths.js';
import type { Match } from './schema.js';
import type { Subject } from './subjects.js';
import type { ActionContext, ActionKind } from './types.js';

const KINDS = new Set<ActionKind>(['shell', 'read', 'write', 'patch', 'fetch', 'mcp', 'tool']);
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

export interface MatchEnv {
  ctx: ActionContext;
  belaydHome: string;
  /** Files the agent changed earlier in this session. */
  sessionWrites: Set<string>;
  /** Lazily loaded values from the workspace `.env` files. */
  envValues(): Map<string, string>;
  /** Another live agent's uncommitted work this subject would clobber, described. */
  othersWork?: (s: Subject) => string | undefined;
  /** What is new in the project's setup since the person last approved it, described. */
  projectSetup?: () => string | undefined;
  /** Packages this subject installs that nobody has heard of, described. */
  unknownPackage?: (s: Subject) => string | undefined;
}

export function createMatchEnv(
  ctx: ActionContext,
  belaydHome: string,
  sessionWrites: Set<string> = new Set(),
  othersWork?: (s: Subject) => string | undefined,
  projectSetup?: () => string | undefined,
  unknownPackage?: (s: Subject) => string | undefined,
): MatchEnv {
  let cached: Map<string, string> | undefined;
  return {
    ctx,
    belaydHome,
    sessionWrites,
    envValues: () => (cached ??= loadEnvValues(ctx.workspace)),
    ...(othersWork ? { othersWork } : {}),
    ...(projectSetup ? { projectSetup } : {}),
    ...(unknownPackage ? { unknownPackage } : {}),
  };
}

export interface MatchResult {
  matched: boolean;
  /** Extra detail for the reason, e.g. which secret was found. */
  detail?: string;
}

export function matches(m: Match, s: Subject, env: MatchEnv): MatchResult {
  if (
    m.tool &&
    !m.tool.some((t) => (KINDS.has(t as ActionKind) ? s.kind === t : wildcard(t, s.toolName ?? '')))
  ) {
    return no;
  }
  if (m.command) {
    if (s.kind !== 'shell' || !s.program) return no;
    if (!m.command.some((c) => commandMatches(c, s))) return no;
  }
  if (m.argv) {
    if (s.kind !== 'shell' || !s.program) return no;
    const words = [s.program, ...s.argv.slice(1)];
    if (words.length !== m.argv.length || !m.argv.every((g, i) => wildcard(g, words[i]!)))
      return no;
  }
  if (m.pathsOnly) {
    // An empty list is "touches no path", not "any path" as elsewhere.
    if (
      m.pathsOnly.length === 0 ? s.paths.length > 0 : !s.paths.every(pathMatcher(m.pathsOnly, env))
    )
      return no;
  }
  if (m.args) {
    const has = (g: string) => s.args.some((a) => wildcard(g, a));
    if (m.args.any && !m.args.any.some(has)) return no;
    if (m.args.all && !m.args.all.every(has)) return no;
    if (m.args.none && m.args.none.some(has)) return no;
  }
  if (m.path && !anyPath(m.path, s.paths, env)) return no;
  if (m.reads && !anyPath(m.reads, s.reads, env)) return no;
  if (m.writes && !anyPath(m.writes, s.writes, env)) return no;
  if (m.domain) {
    const fn = listMatcher(m.domain, (g) => (d: string) => wildcard(g, d, true));
    if (!s.domains.some(fn)) return no;
  }
  if (m.codeFrom && !s.codeFrom.some((p) => m.codeFrom!.some((g) => wildcard(g, p)))) return no;
  if (m.dynamic !== undefined && s.dynamic !== m.dynamic) return no;
  if (m.unresolved !== undefined && s.unresolved !== m.unresolved) return no;
  if (m.inlineCode !== undefined && s.inlineCode !== m.inlineCode) return no;
  if (m.parseError !== undefined && s.parseError !== m.parseError) return no;
  if (m.remote !== undefined && s.remote !== m.remote) return no;
  if (m.changedRunner !== undefined) {
    const hit = s.drivenBy.find((d) => changed(d, env.sessionWrites));
    if (Boolean(hit) !== m.changedRunner) return no;
    if (hit) return { matched: true, detail: hit };
  }
  if (m.changedScript !== undefined) {
    const hit = s.runs.find((r) => env.sessionWrites.has(r));
    if (Boolean(hit) !== m.changedScript) return no;
    if (hit) return { matched: true, detail: hit };
  }
  if (m.othersWork !== undefined) {
    // Untrusted policy code must never throw: a failed check counts as no clobber here,
    // and the rule's other conditions still apply.
    let hit: string | undefined;
    try {
      hit = env.othersWork?.(s);
    } catch {
      hit = undefined;
    }
    if (Boolean(hit) !== m.othersWork) return no;
    if (hit) return { matched: true, detail: hit };
  }
  if (m.gitRunsCode !== undefined) {
    if (Boolean(s.gitRunsCode) !== m.gitRunsCode) return no;
    if (s.gitRunsCode) return { matched: true, detail: s.gitRunsCode };
  }
  if (m.unknownPackage !== undefined) {
    let hit: string | undefined;
    try {
      hit = env.unknownPackage?.(s);
    } catch {
      hit = undefined;
    }
    if (Boolean(hit) !== m.unknownPackage) return no;
    if (hit) return { matched: true, detail: hit };
  }
  if (m.projectSetup !== undefined) {
    let hit: string | undefined;
    try {
      hit = env.projectSetup?.();
    } catch {
      hit = undefined;
    }
    if (Boolean(hit) !== m.projectSetup) return no;
    if (hit) return { matched: true, detail: hit };
  }
  if (m.agentSafetyOff !== undefined) {
    if (Boolean(s.safetyOff) !== m.agentSafetyOff) return no;
    if (s.safetyOff) return { matched: true, detail: s.safetyOff };
  }
  if (m.secrets !== undefined) {
    const found = s.outbound.length > 0 ? findSecrets(s.outbound.join('\n'), env.envValues()) : [];
    if (found.length > 0 !== m.secrets) return no;
    if (found.length > 0) {
      const ids = [...new Set(found.map((f) => f.id))].join(', ');
      return { matched: true, detail: ids };
    }
  }
  return { matched: true };
}

const no: MatchResult = { matched: false };

/** A trailing slash means "anything inside this folder". */
function changed(target: string, writes: Set<string>): boolean {
  if (!target.endsWith('/')) return writes.has(target);
  for (const w of writes) if (w.startsWith(target)) return true;
  return false;
}

/** `git push` matches program `git` whose first positional is `push`. Words may use `*`. */
function commandMatches(pattern: string, s: Subject): boolean {
  const [prog, ...sub] = pattern.trim().split(/\s+/);
  if (!prog || !wildcard(prog, s.program!)) return false;
  return sub.every((word, i) => {
    const p = s.positionals[i];
    return p !== undefined && wildcard(word, p);
  });
}

function anyPath(patterns: string[], paths: string[], env: MatchEnv): boolean {
  if (paths.length === 0) return false;
  const fn = pathMatcher(patterns, env);
  return paths.some(fn);
}

/**
 * Gitignore-style list: a path matches when it matches a positive pattern and no `!` pattern.
 * A list with only `!` patterns matches everything outside them, e.g. `!{workspace}/**`.
 */
function pathMatcher(patterns: string[], env: MatchEnv): (p: string) => boolean {
  // One evaluation can check thousands of paths against the same rules: compile each
  // rule's patterns once per evaluation, not once per path.
  let cache = matcherCache.get(env);
  if (!cache) matcherCache.set(env, (cache = new Map()));
  let fn = cache.get(patterns);
  if (!fn) cache.set(patterns, (fn = buildPathMatcher(patterns, env)));
  return fn;
}

const matcherCache = new WeakMap<MatchEnv, Map<string[], (p: string) => boolean>>();
const placeholderCache = new WeakMap<MatchEnv, Record<string, string[]>>();

function buildPathMatcher(patterns: string[], env: MatchEnv): (p: string) => boolean {
  let vars = placeholderCache.get(env);
  if (!vars) placeholderCache.set(env, (vars = placeholders(env)));
  const expand = (p: string) => expandPlaceholders(p, vars);
  const pos = patterns.filter((p) => !p.startsWith('!')).flatMap(expand);
  const neg = patterns.filter((p) => p.startsWith('!')).flatMap((p) => expand(p.slice(1)));
  const isPos = pos.length > 0 ? anyOf(pos) : () => true;
  const isNeg = neg.length > 0 ? anyOf(neg) : () => false;
  return (p) => {
    const norm = toPosix(p);
    return isPos(norm) && !isNeg(norm);
  };
}

const fold = (s: string) => (CASE_INSENSITIVE_FS ? s.toLowerCase() : s);

/**
 * A matcher for a list of path patterns. Most patterns are plain paths (`{home}/.claude/
 * settings.json`) or a folder and everything in it (`{workspace}/.codex/**`): those are a
 * set lookup and a prefix check, and only real globs go to picomatch. Every write is
 * checked against every write rule, so this is on the hot path. Same answers as picomatch
 * with `dot` and the platform's case rule.
 */
export function anyOf(patterns: string[]): (p: string) => boolean {
  const exact = new Set<string>();
  const folders: string[] = [];
  const globs: string[] = [];
  for (const p of patterns) {
    // Past picomatch's length limit it refuses the pattern; let it, so errors stay errors.
    const plain = p.length <= 65_536 ? literalOf(p) : undefined;
    if (plain !== undefined) exact.add(fold(plain));
    else if (p.length <= 65_536 && p.endsWith('/**') && literalOf(p.slice(0, -3)) !== undefined)
      folders.push(fold(literalOf(p.slice(0, -3))!));
    else globs.push(p);
  }
  const glob =
    globs.length > 0 ? picomatch(globs, { dot: true, nocase: CASE_INSENSITIVE_FS }) : undefined;
  return (p) => {
    if (p === '') return glob ? glob(p) : false;
    const f = fold(p);
    if (exact.has(f)) return true;
    for (const d of folders) if (f === d || f.startsWith(`${d}/`)) return true;
    return glob ? glob(p) : false;
  };
}

/** The pattern as plain text when it has no wildcard or special character, else undefined. */
function literalOf(p: string): string | undefined {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '\\') {
      if (i + 1 >= p.length) return undefined;
      out += p[++i];
    } else if ('*?[]{}()!+@'.includes(c)) return undefined;
    else out += c;
  }
  return out;
}

function listMatcher(
  patterns: string[],
  make: (g: string) => (v: string) => boolean,
): (v: string) => boolean {
  const pos = patterns.filter((p) => !p.startsWith('!')).map(make);
  const neg = patterns.filter((p) => p.startsWith('!')).map((p) => make(p.slice(1)));
  return (v) => (pos.length === 0 || pos.some((f) => f(v))) && !neg.some((f) => f(v));
}

function placeholders(env: MatchEnv): Record<string, string[]> {
  const tmp = new Set([
    '/tmp',
    '/private/tmp',
    '/var/folders',
    '/private/var/folders',
    toPosix(os.tmpdir()),
  ]);
  const both = (p: string) => [...new Set([toPosix(p), toPosix(canonicalPath(p))])];
  return {
    workspace: [env.ctx.workspace, ...(env.ctx.folders ?? [])].flatMap(both),
    cwd: both(env.ctx.cwd),
    home: both(env.ctx.home),
    tmp: [...tmp],
    belayd_home: both(env.belaydHome),
  };
}

export function expandPlaceholders(pattern: string, vars: Record<string, string[]>): string[] {
  let out = [pattern];
  for (const [name, values] of Object.entries(vars)) {
    const token = `{${name}}`;
    if (!pattern.includes(token)) continue;
    out = out.flatMap((p) => values.map((v) => p.split(token).join(escapeGlob(v))));
  }
  return out;
}

function escapeGlob(p: string): string {
  return p.replace(/[\\*?[\]{}()!+@]/g, '\\$&');
}

function toPosix(p: string): string {
  return path.sep === '\\' ? p.split(path.sep).join('/') : p;
}

/**
 * `*` matches anything, `?` one character. Everything else is literal.
 *
 * A loop rather than a regular expression: a pattern like `*e*e*e*Q` from a project
 * file would make a regex backtrack for minutes, and this stays linear per star.
 */
export function wildcard(glob: string, value: string, nocase = false): boolean {
  if (nocase) {
    glob = glob.toLowerCase();
    value = value.toLowerCase();
  }
  let g = 0;
  let v = 0;
  let star = -1;
  let resume = 0;
  while (v < value.length) {
    if (g < glob.length && (glob[g] === '?' || glob[g] === value[v])) {
      g++;
      v++;
    } else if (g < glob.length && glob[g] === '*') {
      star = g++;
      resume = v;
    } else if (star >= 0) {
      g = star + 1;
      v = ++resume;
    } else return false;
  }
  while (glob[g] === '*') g++;
  return g === glob.length;
}
