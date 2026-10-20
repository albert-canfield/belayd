import { untrustedGit } from '../util/git.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DoctorLine } from './types.js';

/** Plumbing every agent adapter shares: settings files, quoting, versions. */

export type Settings = Record<string, unknown>;

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function tilde(p: string): string {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/**
 * The command that runs belayd's hook for an agent, through a shell. A crash or a kill
 * turns into exit 2, which every supported agent treats as a block, with a reason.
 */
export function guardedCommand(opts: {
  nodePath: string;
  binPath: string;
  agent: string;
  timeout: number;
  extra?: string[];
  guard?: boolean;
}): string {
  const run = [
    shellQuote(opts.nodePath),
    shellQuote(opts.binPath),
    'hook',
    opts.agent,
    '--timeout',
    String(opts.timeout),
    ...(opts.extra ?? []),
  ].join(' ');
  if (opts.guard === false) return run;
  return `${run} || { echo "belayd is not working, so this action is blocked to be safe. Run: belayd doctor" >&2; exit 2; }`;
}

/**
 * True for a hook entry belayd installed, whichever agent it is for. Recognised by
 * belayd's own command structure, not by the install path, which may not say belayd.
 */
export function isBelaydHandler(h: unknown): boolean {
  if (!h || typeof h !== 'object') return false;
  const entry = h as Record<string, unknown>;
  const args = Array.isArray(entry.args) ? entry.args : undefined;
  if (args && args[1] === 'hook' && typeof args[2] === 'string') return true;
  return Object.values(entry).some(
    (v) => typeof v === 'string' && /\bhook [a-z][a-z-]* --timeout \d+\b/.test(v),
  );
}

export function readSettings(file: string): Settings {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (text.trim() === '') return {};
  try {
    const data = JSON.parse(text) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('not a JSON object');
    return data as Settings;
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON (${(err as Error).message}). Fix it first, belayd will not overwrite it.`,
      { cause: err },
    );
  }
}

/** Writes JSON with a timestamped backup of the previous file. Returns the backup path. */
export function writeSettings(file: string, settings: Settings): string | undefined {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup: string | undefined;
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${file}.belayd-backup-${stamp}`;
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.belayd-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return backup;
}

/** Keeps a per-person settings file out of Git without touching the project's .gitignore. */
export function excludeFromGit(workspace: string, file: string): boolean {
  const gitDir = path.join(workspace, '.git');
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return false;
  const rel = path.relative(workspace, file).split(path.sep).join('/');
  try {
    untrustedGit(['check-ignore', '-q', rel], { cwd: workspace });
    return false; // already ignored
  } catch {
    // not ignored yet
  }
  const exclude = path.join(gitDir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(exclude, `${prefix}${rel}\n`);
  return true;
}

/*
 * Hook files where events map to matcher groups, the format Claude Code and Codex share:
 * `{ "hooks": { "PreToolUse": [{ "matcher": "*", "hooks": [handler] }] } }`.
 */
interface MatcherGroup {
  matcher?: string;
  hooks?: unknown[];
}

/** A copy with every belayd hook removed, then `add` added (if given). */
export function mergeMatcherHooks(
  settings: Settings,
  add: Record<string, unknown> | undefined,
  matcher = '*',
): Settings {
  const next = structuredClone(settings);
  const hooks = { ...(asRecord(next.hooks) as Record<string, MatcherGroup[] | undefined>) };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const cleaned = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isBelaydHandler(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (cleaned.length > 0) hooks[event] = cleaned;
    else delete hooks[event];
  }
  for (const [event, handler] of Object.entries(add ?? {})) {
    if (handler) hooks[event] = [...(hooks[event] ?? []), { matcher, hooks: [handler] }];
  }
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

/** belayd's handler for an event in a matcher-group hook file, if installed. */
export function findMatcherHook(
  settings: Settings,
  event: string,
): (Record<string, unknown> & { command?: string; args?: string[] }) | undefined {
  const groups = asRecord(settings.hooks)[event];
  for (const group of Array.isArray(groups) ? (groups as MatcherGroup[]) : []) {
    for (const h of group.hooks ?? []) if (isBelaydHandler(h)) return h as Record<string, never>;
  }
  return undefined;
}

/*
 * Hook files where each event lists its hook entries directly, the format Copilot CLI
 * uses: `{ "hooks": { "preToolUse": [{ "type": "command", "bash": "..." }] } }`.
 */

/** A copy with every belayd hook removed, then `add` added (if given). */
export function mergeFlatHooks(
  settings: Settings,
  add: Record<string, unknown> | undefined,
): Settings {
  const next = structuredClone(settings);
  const hooks = { ...(asRecord(next.hooks) as Record<string, unknown[] | undefined>) };
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((h) => !isBelaydHandler(h));
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  for (const [event, entry] of Object.entries(add ?? {}))
    if (entry) hooks[event] = [...(hooks[event] ?? []), entry];
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

/** belayd's entry for an event in a flat hook file, if installed. */
export function findFlatHook(
  settings: Settings,
  event: string,
): Record<string, unknown> | undefined {
  const entries = asRecord(settings.hooks)[event];
  return Array.isArray(entries)
    ? (entries.find(isBelaydHandler) as Record<string, unknown> | undefined)
    : undefined;
}

/** The two absolute paths a hook command runs: node and belayd's bin.js. */
export function pinnedPaths(entry: {
  command?: unknown;
  args?: unknown;
  exec?: unknown;
  bash?: unknown;
}): string[] {
  if (Array.isArray(entry.args) && typeof (entry.exec ?? entry.command) === 'string')
    return [String(entry.exec ?? entry.command), String(entry.args[0])];
  const command =
    typeof entry.command === 'string'
      ? entry.command
      : typeof entry.bash === 'string'
        ? entry.bash
        : '';
  const words = [...command.matchAll(/'([^']+)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? '');
  return words.slice(0, 2).filter((p) => p.startsWith('/'));
}

/**
 * Doctor lines for an agent's hook files: which ones hold belayd's hook, and whether
 * the paths it runs still exist (a moved install would block every tool call).
 */
export function hookFileLines(opts: {
  name: string;
  files: string[];
  find: (settings: Settings) => Record<string, unknown> | undefined;
  okHint?: string;
  describe?: (entry: Record<string, unknown>) => string | undefined;
  missingHint: string;
}): { lines: DoctorLine[]; installed: number } {
  const lines: DoctorLine[] = [];
  let installed = 0;
  for (const file of opts.files) {
    if (!fs.existsSync(file)) continue;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = opts.find(readSettings(file));
    } catch (err) {
      lines.push({
        status: 'fail',
        text: `Cannot read ${tilde(file)}`,
        hint: (err as Error).message,
      });
      continue;
    }
    if (!entry) continue;
    installed++;
    const missing = pinnedPaths(entry).filter((p) => !fs.existsSync(p));
    if (missing.length > 0) {
      lines.push({
        status: 'fail',
        text: `${opts.name} hook in ${tilde(file)} points to files that no longer exist`,
        hint: `${missing.join(', ')}. Every tool call is being blocked. ${opts.missingHint}`,
      });
    } else {
      const extra = opts.describe?.(entry);
      lines.push({
        status: 'ok',
        text: `${opts.name} hook installed in ${tilde(file)}${extra ? ` (${extra})` : ''}`,
        ...(opts.okHint ? { hint: opts.okHint } : {}),
      });
    }
  }
  return { lines, installed };
}
