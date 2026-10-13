import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where belayd keeps its own state. Override with BELAYD_HOME (tests always do). */
export function belaydHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.BELAYD_HOME ? path.resolve(env.BELAYD_HOME) : path.join(os.homedir(), '.belayd');
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || os.homedir();
}

/** The repository root containing `cwd`, or `cwd` itself when it is not inside a Git repository. */
export function findWorkspace(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}
