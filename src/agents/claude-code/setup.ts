import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareVersions,
  excludeFromGit,
  findMatcherHook,
  guardedCommand,
  hookFileLines,
  mergeMatcherHooks,
  readSettings,
  writeSettings,
} from '../common.js';
import type { AgentSetup, DoctorLine, SetupOptions } from '../types.js';
import { findMods, managedSettingsFile } from './mods.js';

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
  return {
    type: 'command',
    command: guardedCommand({ ...opts, agent: 'claude-code', timeout: HOOK_TIMEOUT_SECONDS }),
    timeout: HOOK_TIMEOUT_SECONDS,
  };
}

/** Hook events belayd installs, and what each one is for. */
export type BelaydHooks = Partial<
  Record<'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure', HookHandler>
>;

/** PostToolUse records what actually ran. It cannot block, so it gets no guard and a short timeout. */
export const POST_HOOK_TIMEOUT_SECONDS = 30;

export function belaydHooks(opts: {
  nodePath: string;
  binPath: string;
  claudeVersion: string | undefined;
}): BelaydHooks {
  const post: HookHandler = supportsOnFailure(opts.claudeVersion)
    ? {
        type: 'command',
        command: opts.nodePath,
        args: [opts.binPath, 'hook', 'claude-code', '--timeout', String(POST_HOOK_TIMEOUT_SECONDS)],
        timeout: POST_HOOK_TIMEOUT_SECONDS,
      }
    : {
        type: 'command',
        command: guardedCommand({
          ...opts,
          agent: 'claude-code',
          timeout: POST_HOOK_TIMEOUT_SECONDS,
          guard: false,
        }),
        timeout: POST_HOOK_TIMEOUT_SECONDS,
      };
  return { PreToolUse: hookHandler(opts), PostToolUse: post, PostToolUseFailure: post };
}

export const claudeSetup: AgentSetup = {
  plan(opts) {
    const target = claudeTarget(targetOptions(opts));
    const claudeVersion = opts.claudeVersion ?? detectClaudeVersion(opts.env);
    const hooks = belaydHooks({ nodePath: opts.nodePath, binPath: opts.binPath, claudeVersion });
    const warnings: string[] = [];
    if (!supportsOnFailure(claudeVersion)) {
      warnings.push(
        claudeVersion
          ? `Claude Code ${claudeVersion} is older than ${ON_FAILURE_MIN_VERSION}.`
          : 'Could not find Claude Code to check its version.',
        `Using a shell guard that blocks when belayd crashes. Update Claude Code to ${ON_FAILURE_MIN_VERSION}+ and run init again to also block on hook timeouts.`,
      );
    }
    return {
      file: target.settingsFile,
      scope: target.scope,
      shown: hooks.PreToolUse,
      warnings,
      after: 'Claude Code: restart it (or open /hooks) so it picks up the new hooks.',
      apply: () => {
        const backup = writeSettings(
          target.settingsFile,
          mergeMatcherHooks(readSettings(target.settingsFile), hooks),
        );
        if (target.scope === 'project') excludeFromGit(opts.workspace, target.settingsFile);
        return backup;
      },
    };
  },
  uninstall(opts) {
    const file = claudeTarget(targetOptions(opts)).settingsFile;
    return removeMatcherHooks(file);
  },
  doctor(opts) {
    const lines: DoctorLine[] = [];
    const v = detectClaudeVersion(opts.env);
    if (!v) lines.push({ status: 'warn', text: 'Claude Code: `claude` command not found on PATH' });
    else if (supportsOnFailure(v)) lines.push({ status: 'ok', text: `Claude Code ${v}` });
    else
      lines.push({
        status: 'warn',
        text: `Claude Code ${v} is older than ${ON_FAILURE_MIN_VERSION}`,
        hint: 'Hook timeouts are not blocked on this version. Update Claude Code, then run belayd init again.',
      });
    const { lines: files, installed } = hookFileLines({
      name: 'Claude Code',
      files: [
        path.join(opts.workspace, '.claude', 'settings.local.json'),
        path.join(opts.workspace, '.claude', 'settings.json'),
        path.join(claudeConfigDir(opts.claudeConfigDir, opts.env), 'settings.json'),
      ],
      find: (settings) => findMatcherHook(settings, 'PreToolUse'),
      describe: (entry) => (entry.onFailure === 'block' ? 'blocks on failure' : 'shell guard'),
      missingHint: 'Run belayd init again.',
    });
    lines.push(...files);
    const plugin = belaydPlugin(claudeConfigDir(opts.claudeConfigDir, opts.env));
    if (plugin) {
      lines.push(
        installed > 0
          ? {
              status: 'warn',
              text: `Claude Code has both the ${plugin} plugin and belayd hooks in its settings`,
              hint: 'Every tool call is checked twice. Keep one: belayd uninstall, or turn the plugin off in /plugin.',
            }
          : { status: 'ok', text: `Claude Code: the ${plugin} plugin is on` },
      );
    } else if (installed === 0)
      lines.push({
        status: 'warn',
        text: 'No belayd hook found for Claude Code',
        hint: 'Run: belayd init, or in Claude Code: /plugin install belayd --marketplace albert-canfield/belayd',
      });
    lines.push(...modLines(claudeConfigDir(opts.claudeConfigDir, opts.env), opts));
    return lines;
  },
};

/** The belayd plugin's id when it is turned on in Claude Code's user settings. */
function belaydPlugin(configDir: string): string | undefined {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')) as {
      enabledPlugins?: Record<string, unknown>;
    };
    return Object.entries(settings.enabledPlugins ?? {}).find(
      ([id, on]) => id.startsWith('belayd@') && on === true,
    )?.[0];
  } catch {
    return undefined;
  }
}

/** Mods that can overrule belayd's answer, and whether Claude Code's guard stops them. */
function modLines(configDir: string, opts: { workspace: string; env: NodeJS.ProcessEnv }) {
  const mods = findMods({ configDir, workspace: opts.workspace, env: opts.env });
  const overruling = mods.filter((m) => m.overrules.length > 0);
  if (overruling.length === 0) {
    return mods.length > 0
      ? [
          {
            status: 'ok' as const,
            text: `Claude Code mods: ${mods.length}, none can overrule belayd`,
          },
        ]
      : [];
  }
  const managed = managedSettingsFile();
  return overruling.map((m) =>
    managed
      ? {
          status: 'ok' as const,
          text: `Claude Code mod ${m.name} handles ${m.overrules.join(', ')}; managed settings keep it from overruling belayd`,
        }
      : {
          status: 'warn' as const,
          text: `Claude Code mod ${m.name} can overrule belayd (it handles ${m.overrules.join(', ')})`,
          hint: `Without managed settings or a Team or Enterprise login, a mod can approve a call belayd blocked. Check what it does with: claude plugin validate "${m.dir}". Turn it off in /plugin if you don't trust it.`,
        },
  );
}

function targetOptions(opts: SetupOptions) {
  return {
    ...(opts.global ? { global: true } : {}),
    ...(opts.claudeConfigDir ? { claudeConfigDir: opts.claudeConfigDir } : {}),
    workspace: opts.workspace,
    env: opts.env,
  };
}

/** Removes belayd from a matcher-group hook file (Claude Code, Codex). */
export function removeMatcherHooks(file: string) {
  if (!fs.existsSync(file)) return [];
  const settings = readSettings(file);
  const next = mergeMatcherHooks(settings, undefined);
  if (JSON.stringify(next) === JSON.stringify(settings)) return [];
  return [{ file, apply: () => writeSettings(file, next) }];
}
