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
  /** Lazily loaded values from the workspace `.env` files. */
  envValues(): Map<string, string>;
}

export function createMatchEnv(ctx: ActionContext, belaydHome: string): MatchEnv {
  let cached: Map<string, string> | undefined;
  return {
    ctx,
    belaydHome,
    envValues: () => (cached ??= loadEnvValues(ctx.workspace)),
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
  const vars = placeholders(env);
  const expand = (p: string) => expandPlaceholders(p, vars);
  const pos = patterns.filter((p) => !p.startsWith('!')).flatMap(expand);
  const neg = patterns.filter((p) => p.startsWith('!')).flatMap((p) => expand(p.slice(1)));
  const opts = { dot: true, nocase: CASE_INSENSITIVE_FS };
  const isPos = pos.length > 0 ? picomatch(pos, opts) : () => true;
  const isNeg = neg.length > 0 ? picomatch(neg, opts) : () => false;
  return (p) => {
    const norm = toPosix(p);
    return isPos(norm) && !isNeg(norm);
  };
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
    workspace: both(env.ctx.workspace),
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

const wildcardCache = new Map<string, RegExp>();

/** `*` matches anything, `?` one character. Everything else is literal. */
export function wildcard(glob: string, value: string, nocase = false): boolean {
  const key = (nocase ? 'i:' : 's:') + glob;
  let re = wildcardCache.get(key);
  if (!re) {
    const body = glob
      .split('')
      .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('');
    re = new RegExp(`^${body}$`, nocase ? 'is' : 's');
    wildcardCache.set(key, re);
  }
  return re.test(value);
}
