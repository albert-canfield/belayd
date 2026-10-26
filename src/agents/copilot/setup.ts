import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  excludeFromGit,
  findFlatHook,
  guardedCommand,
  hookFileLines,
  mergeFlatHooks,
  readSettings,
  writeSettings,
} from '../common.js';
import type { AgentSetup, DoctorLine, Removal, SetupOptions } from '../types.js';

/**
 * Long enough for a held call. Copilot CLI lets the tool run when a hook times out,
 * so belayd's own deadline (passed as --timeout) always answers a few seconds before.
 */
export const COPILOT_HOOK_TIMEOUT_SECONDS = 180;
const POST_TIMEOUT_SECONDS = 30;

export function copilotHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.COPILOT_HOME ?? path.join(env.HOME || os.homedir(), '.copilot'));
}

/**
 * Project hooks go in Copilot CLI's per-person settings file, kept out of Git. User
 * hooks get a file of their own in `~/.copilot/hooks/`.
 */
export function copilotTarget(opts: {
  global?: boolean;
  workspace: string;
  env: NodeJS.ProcessEnv;
}) {
  return opts.global
    ? { scope: 'global' as const, file: path.join(copilotHome(opts.env), 'hooks', 'belayd.json') }
    : {
        scope: 'project' as const,
        file: path.join(opts.workspace, '.github', 'copilot', 'settings.local.json'),
      };
}

export function copilotHooks(opts: { nodePath: string; binPath: string }) {
  const entry = (event: string, timeout: number, guard: boolean) => ({
    type: 'command',
    bash: guardedCommand({ ...opts, agent: 'copilot', timeout, guard, extra: ['--event', event] }),
    timeoutSec: timeout,
  });
  return {
    preToolUse: entry('preToolUse', COPILOT_HOOK_TIMEOUT_SECONDS, true),
    postToolUse: entry('postToolUse', POST_TIMEOUT_SECONDS, false),
    postToolUseFailure: entry('postToolUseFailure', POST_TIMEOUT_SECONDS, false),
  };
}

export const copilotSetup: AgentSetup = {
  plan(opts) {
    const target = copilotTarget(targetOptions(opts));
    const hooks = copilotHooks(opts);
    return {
      file: target.file,
      scope: target.scope,
      shown: hooks.preToolUse,
      warnings: [],
      after:
        target.scope === 'project'
          ? 'Copilot CLI: restart it. It runs project hooks once you trust this folder in it.'
          : 'Copilot CLI: restart it so it picks up the new hooks.',
      apply: () => {
        const current = readSettings(target.file);
        const next = mergeFlatHooks(current, hooks);
        if (target.scope === 'global') next.version = 1;
        const backup = writeSettings(target.file, next);
        if (target.scope === 'project') excludeFromGit(opts.workspace, target.file);
        return backup;
      },
    };
  },
  uninstall(opts) {
    const { file, scope } = copilotTarget(targetOptions(opts));
    if (!fs.existsSync(file)) return [];
    const settings = readSettings(file);
    const next = mergeFlatHooks(settings, undefined);
    if (JSON.stringify(next) === JSON.stringify(settings)) return [];
    const removal: Removal = {
      file,
      apply: () => {
        // belayd's own file in ~/.copilot/hooks goes away when nothing else is in it.
        if (scope === 'global' && Object.keys(next).every((k) => k === 'version')) {
          fs.rmSync(file);
          return undefined;
        }
        return writeSettings(file, next);
      },
    };
    return [removal];
  },
  doctor(opts) {
    const lines: DoctorLine[] = [];
    const { lines: files, installed } = hookFileLines({
      name: 'Copilot CLI',
      files: [
        copilotTarget({ workspace: opts.workspace, env: opts.env }).file,
        copilotTarget({ global: true, workspace: opts.workspace, env: opts.env }).file,
      ],
      find: (settings) => findFlatHook(settings, 'preToolUse'),
      okHint: 'Copilot CLI runs project hooks only after you trust the folder in it.',
      missingHint: 'Run belayd init --agent copilot again.',
    });
    lines.push(...files);
    if (installed === 0)
      lines.push({
        status: 'warn',
        text: 'Copilot CLI found, but no belayd hook for it',
        hint: 'Run: belayd init --agent copilot',
      });
    else
      lines.push({
        status: 'note',
        text: 'Copilot CLI lets a tool run when its hook times out.',
        hint: `belayd answers within ${COPILOT_HOOK_TIMEOUT_SECONDS} s, a question to you included, so this only matters if belayd cannot run at all.`,
      });
    return lines;
  },
};

/** True when belayd's own Copilot CLI hooks are installed for this folder or this user. */
export function copilotHooksInstalled(workspace: string, env: NodeJS.ProcessEnv): boolean {
  for (const global of [false, true]) {
    try {
      const file = copilotTarget({ global, workspace, env }).file;
      if (fs.existsSync(file) && findFlatHook(readSettings(file), 'preToolUse')) return true;
    } catch {
      // unreadable: not installed as far as belayd can tell
    }
  }
  return false;
}

function targetOptions(opts: SetupOptions) {
  return { ...(opts.global ? { global: true } : {}), workspace: opts.workspace, env: opts.env };
}
