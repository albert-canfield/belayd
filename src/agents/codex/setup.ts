import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeMatcherHooks, type HookHandler } from '../claude-code/setup.js';
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

/** Same budget as Claude Code: long enough for a held approval, answered 5 s early. */
export const CODEX_HOOK_TIMEOUT_SECONDS = 180;
const POST_TIMEOUT_SECONDS = 30;

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
}

/** Codex is around when its config folder exists. */
export function codexDetected(env: NodeJS.ProcessEnv = process.env): boolean {
  return fs.existsSync(codexHome(env));
}

export function codexTarget(opts: {
  global?: boolean;
  workspace: string;
  env: NodeJS.ProcessEnv;
}): {
  scope: 'project' | 'global';
  hooksFile: string;
} {
  if (opts.global)
    return { scope: 'global', hooksFile: path.join(codexHome(opts.env), 'hooks.json') };
  return { scope: 'project', hooksFile: path.join(opts.workspace, '.codex', 'hooks.json') };
}

/**
 * Codex runs hook commands through a shell and has no exec form. Paths are quoted,
 * and a crash turns into exit 2, which blocks: Codex fails open on hook errors.
 */
export function codexHooks(opts: { nodePath: string; binPath: string }) {
  const command = (timeout: number, guard: boolean) =>
    guardedCommand({ ...opts, agent: 'codex', timeout, guard });
  const pre: HookHandler & { statusMessage: string } = {
    type: 'command',
    command: command(CODEX_HOOK_TIMEOUT_SECONDS, true),
    timeout: CODEX_HOOK_TIMEOUT_SECONDS,
    statusMessage: 'belayd is checking this',
  };
  const post: HookHandler = {
    type: 'command',
    command: command(POST_TIMEOUT_SECONDS, false),
    timeout: POST_TIMEOUT_SECONDS,
  };
  return { PreToolUse: pre, PostToolUse: post };
}

export const codexSetup: AgentSetup = {
  plan(opts) {
    const target = codexTarget(targetOptions(opts));
    const hooks = codexHooks(opts);
    return {
      file: target.hooksFile,
      scope: target.scope,
      shown: hooks.PreToolUse,
      warnings:
        target.scope === 'project'
          ? ['Codex only loads project hooks when you trust the project in Codex.']
          : [],
      after:
        'Codex: open it and run /hooks once to review and trust the belayd hooks. Codex skips hooks until you do.',
      apply: () => {
        const backup = writeSettings(
          target.hooksFile,
          mergeMatcherHooks(readSettings(target.hooksFile), hooks),
        );
        if (target.scope === 'project') excludeFromGit(opts.workspace, target.hooksFile);
        return backup;
      },
    };
  },
  uninstall: (opts) => removeMatcherHooks(codexTarget(targetOptions(opts)).hooksFile),
  doctor(opts) {
    const lines: DoctorLine[] = [];
    const { lines: files, installed } = hookFileLines({
      name: 'Codex',
      files: [
        path.join(opts.workspace, '.codex', 'hooks.json'),
        path.join(codexHome(opts.env), 'hooks.json'),
      ],
      find: (settings) => findMatcherHook(settings, 'PreToolUse'),
      okHint: 'Codex skips new or changed hooks until you trust them: run /hooks in Codex once.',
      missingHint: 'Run belayd init --agent codex again.',
    });
    lines.push(...files);
    if (installed === 0)
      lines.push({
        status: 'warn',
        text: 'Codex found, but no belayd hook for it',
        hint: 'Run: belayd init --agent codex',
      });
    return lines;
  },
};

function targetOptions(opts: SetupOptions) {
  return { ...(opts.global ? { global: true } : {}), workspace: opts.workspace, env: opts.env };
}
