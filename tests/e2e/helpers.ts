import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const bin = path.join(root, 'dist', 'bin.js');

export interface Sandbox {
  dir: string;
  project: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/**
 * A throwaway machine: fake HOME, fake Claude Code config dir, fake BELAYD_HOME and a
 * Git project. Nothing here can reach the real ~/.claude.
 */
export function sandbox(): Sandbox {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-e2e-')));
  const project = path.join(dir, 'project');
  fs.mkdirSync(path.join(project, '.git', 'info'), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: path.join(dir, 'home'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'),
    BELAYD_HOME: path.join(dir, 'belayd-home'),
    NO_COLOR: '1',
  };
  fs.mkdirSync(env.HOME!, { recursive: true });
  return { dir, project, env, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function belayd(
  sb: Sandbox,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: opts.cwd ?? sb.project,
    env: { ...sb.env, ...opts.env },
    input: opts.input ?? '',
    encoding: 'utf8',
  });
}

export function hookPayload(sb: Sandbox, tool: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'e2e',
    cwd: sb.project,
    tool_name: tool,
    tool_input: input,
  });
}
