import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { removeMatcherHooks } from '../claude-code/setup.js';
import {
  excludeFromGit,
  findMatcherHook,
  guardedCommand,
  hookFileLines,
  mergeMatcherHooks,
  readSettings,
  writeSettings,
} from '../common.js';
import type { AgentSetup, DoctorLine, SetupOptions } from '../types.js';

/**
 * Gemini CLI hook timeouts are in milliseconds. belayd's own deadline (--timeout, in
 * seconds) answers a few seconds before, so a slow approval ends in belayd's no.
 */
export const GEMINI_HOOK_TIMEOUT_SECONDS = 180;
const POST_TIMEOUT_SECONDS = 30;
/** Gemini CLI matches tool names with a regular expression. */
const ALL_TOOLS = '.*';

export function geminiHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.resolve(env.GEMINI_CLI_HOME ?? env.HOME ?? os.homedir()), '.gemini');
}

export function geminiTarget(opts: {
  global?: boolean;
  workspace: string;
  env: NodeJS.ProcessEnv;
}) {
  return opts.global
    ? { scope: 'global' as const, file: path.join(geminiHome(opts.env), 'settings.json') }
    : { scope: 'project' as const, file: path.join(opts.workspace, '.gemini', 'settings.json') };
}

export function geminiHooks(opts: { nodePath: string; binPath: string }) {
  const entry = (timeout: number, guard: boolean) => ({
    name: 'belayd',
    type: 'command',
    command: guardedCommand({ ...opts, agent: 'gemini', timeout, guard }),
    timeout: timeout * 1000,
  });
  return {
    BeforeTool: entry(GEMINI_HOOK_TIMEOUT_SECONDS, true),
    AfterTool: entry(POST_TIMEOUT_SECONDS, false),
  };
}

export const geminiSetup: AgentSetup = {
  plan(opts) {
    const target = geminiTarget(targetOptions(opts));
    const hooks = geminiHooks(opts);
    const warnings: string[] = [];
    if (target.scope === 'project' && trackedByGit(opts.workspace, target.file))
      warnings.push(
        `${path.relative(opts.workspace, target.file)} is committed to this repository. belayd's hook names paths on this machine, so prefer --global for Gemini CLI.`,
      );
    return {
      file: target.file,
      scope: target.scope,
      shown: hooks.BeforeTool,
      warnings,
      after:
        target.scope === 'project'
          ? 'Gemini CLI: restart it. It runs project hooks only in folders you trust.'
          : 'Gemini CLI: restart it so it picks up the new hooks.',
      apply: () => {
        const backup = writeSettings(
          target.file,
          mergeMatcherHooks(readSettings(target.file), hooks, ALL_TOOLS),
        );
        if (target.scope === 'project') excludeFromGit(opts.workspace, target.file);
        return backup;
      },
    };
  },
  uninstall: (opts) => removeMatcherHooks(geminiTarget(targetOptions(opts)).file),
  doctor(opts) {
    const lines: DoctorLine[] = [];
    const { lines: files, installed } = hookFileLines({
      name: 'Gemini CLI',
      files: [
        geminiTarget({ workspace: opts.workspace, env: opts.env }).file,
        geminiTarget({ global: true, workspace: opts.workspace, env: opts.env }).file,
      ],
      find: (settings) => findMatcherHook(settings, 'BeforeTool'),
      okHint: 'Gemini CLI runs project hooks only in folders you trust.',
      missingHint: 'Run belayd init --agent gemini again.',
    });
    lines.push(...files);
    if (installed === 0)
      lines.push({
        status: 'warn',
        text: 'Gemini CLI found, but no belayd hook for it',
        hint: 'Run: belayd init --agent gemini',
      });
    return lines;
  },
};

function trackedByGit(workspace: string, file: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', path.relative(workspace, file)], {
      cwd: workspace,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function targetOptions(opts: SetupOptions) {
  return { ...(opts.global ? { global: true } : {}), workspace: opts.workspace, env: opts.env };
}
