import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code added `onFailure: "block"` in this version. Older versions fail open on hook errors. */
export const ON_FAILURE_MIN_VERSION = '2.1.295';
/**
 * Long enough for a held call (approval timeout, 120 s by default) plus margin.
 * The hook gets this value as --timeout and always answers a few seconds before it.
 */
export const HOOK_TIMEOUT_SECONDS = 180;

export interface ClaudeTarget {
  scope: 'project' | 'global';
  settingsFile: string;
}

export interface HookHandler {
  type: 'command';
  command: string;
  args?: string[];
  timeout: number;
  onFailure?: 'block';
}

interface MatcherGroup {
  matcher?: string;
  hooks?: unknown[];
}

type Settings = Record<string, unknown> & { hooks?: Record<string, MatcherGroup[] | undefined> };

export function claudeConfigDir(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  return path.resolve(explicit ?? env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'));
}

export function claudeTarget(opts: {
  global?: boolean;
  claudeConfigDir?: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}): ClaudeTarget {
  if (opts.global) {
    return {
      scope: 'global',
      settingsFile: path.join(claudeConfigDir(opts.claudeConfigDir, opts.env), 'settings.json'),
    };
  }
  return {
    scope: 'project',
    settingsFile: path.join(opts.workspace, '.claude', 'settings.local.json'),
  };
}

/** The installed Claude Code version, or undefined when `claude` is not on PATH. */
export function detectClaudeVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // Lets tests (and unusual setups) state the version instead of running `claude`.
  if (env.BELAYD_CLAUDE_VERSION) return env.BELAYD_CLAUDE_VERSION;
  try {
    const out = execFileSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const v = /(\d+\.\d+\.\d+)/.exec(out)?.[1];
    if (v) return v;
  } catch {
    // not on PATH; many people only use the editor extension
  }
  return editorExtensionVersion(env);
}

/**
 * The newest Claude Code bundled with the VS Code or Cursor extension. When several are
 * installed, the oldest one still in use could be older, so this is a best guess.
 */
function editorExtensionVersion(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME || os.homedir();
  const versions: string[] = [];
  for (const dir of ['.vscode/extensions', '.vscode-insiders/extensions', '.cursor/extensions']) {
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(home, dir));
    } catch {
      continue;
    }
    for (const e of entries) {
      const m = /^anthropic\.claude-code-(\d+\.\d+\.\d+)/.exec(e);
      if (m) versions.push(m[1]!);
    }
  }
  return versions.sort(compareVersions).at(-1);
}

export function supportsOnFailure(version: string | undefined): boolean {
  return version !== undefined && compareVersions(version, ON_FAILURE_MIN_VERSION) >= 0;
}

/**
 * Builds the hook entry. With a recent Claude Code we use exec form (no shell, no quoting
 * problems) and `onFailure: "block"`. Otherwise a shell command that turns any crash into exit 2.
 */
export function hookHandler(opts: {
  nodePath: string;
  binPath: string;
  claudeVersion: string | undefined;
}): HookHandler {
  if (supportsOnFailure(opts.claudeVersion)) {
    return {
      type: 'command',
      command: opts.nodePath,
      args: [opts.binPath, 'hook', 'claude-code', '--timeout', String(HOOK_TIMEOUT_SECONDS)],
      timeout: HOOK_TIMEOUT_SECONDS,
      onFailure: 'block',
    };
  }
  const run = `${shellQuote(opts.nodePath)} ${shellQuote(opts.binPath)} hook claude-code --timeout ${HOOK_TIMEOUT_SECONDS}`;
  const guard = `{ echo "belayd is not working, so this action is blocked to be safe. Run: belayd doctor" >&2; exit 2; }`;
  return { type: 'command', command: `${run} || ${guard}`, timeout: HOOK_TIMEOUT_SECONDS };
}

export function isBelaydHandler(h: unknown): boolean {
  if (!h || typeof h !== 'object') return false;
  const { command, args } = h as { command?: unknown; args?: unknown };
  if (Array.isArray(args) && args[1] === 'hook' && args[2] === 'claude-code') return true;
  return (
    typeof command === 'string' && /belayd/.test(command) && /\bhook claude-code\b/.test(command)
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

/** Returns a copy of `settings` with every belayd hook removed, then `handler` added (if given). */
export function withBelaydHook(settings: Settings, handler: HookHandler | undefined): Settings {
  const next: Settings = structuredClone(settings);
  const hooks = { ...(next.hooks ?? {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const cleaned = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isBelaydHandler(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (cleaned.length > 0) hooks[event] = cleaned;
    else delete hooks[event];
  }
  if (handler) hooks.PreToolUse = [...(hooks.PreToolUse ?? []), { matcher: '*', hooks: [handler] }];
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

export function findInstalledHandler(settings: Settings): HookHandler | undefined {
  for (const group of settings.hooks?.PreToolUse ?? []) {
    for (const h of group.hooks ?? []) if (isBelaydHandler(h)) return h as HookHandler;
  }
  return undefined;
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

/** Keeps `.claude/settings.local.json` out of Git without touching the project's .gitignore. */
export function excludeFromGit(workspace: string, file: string): boolean {
  const gitDir = path.join(workspace, '.git');
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return false;
  const rel = path.relative(workspace, file).split(path.sep).join('/');
  try {
    execFileSync('git', ['check-ignore', '-q', rel], { cwd: workspace, stdio: 'ignore' });
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

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
