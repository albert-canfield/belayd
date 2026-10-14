import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellQuote, type HookHandler } from '../claude-code/install.js';

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
  const run = (timeout: number) =>
    `${shellQuote(opts.nodePath)} ${shellQuote(opts.binPath)} hook codex --timeout ${timeout}`;
  const pre: HookHandler & { statusMessage: string } = {
    type: 'command',
    command: `${run(CODEX_HOOK_TIMEOUT_SECONDS)} || { echo "belayd is not working, so this action is blocked to be safe. Run: belayd doctor" >&2; exit 2; }`,
    timeout: CODEX_HOOK_TIMEOUT_SECONDS,
    statusMessage: 'belayd is checking this',
  };
  const post: HookHandler = {
    type: 'command',
    command: run(POST_TIMEOUT_SECONDS),
    timeout: POST_TIMEOUT_SECONDS,
  };
  return { PreToolUse: pre, PostToolUse: post };
}
