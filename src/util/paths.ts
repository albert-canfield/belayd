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
  const start = canonicalPath(cwd);
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

const canonicalCache = new Map<string, string>();

/**
 * Resolves symlinks in the part of `p` that exists, keeping the rest as written.
 * Rules then judge the real location: a symlink in the project that points into
 * ~/.ssh is treated as ~/.ssh, and /tmp and /private/tmp on macOS are one place.
 */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  const cached = canonicalCache.get(abs);
  if (cached) return cached;
  let existing = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(existing);
      const out = rest.length > 0 ? path.join(real, ...rest.reverse()) : real;
      canonicalCache.set(abs, out);
      return out;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) {
        canonicalCache.set(abs, abs);
        return abs;
      }
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * belayd's folders hold the audit log, snapshots and approval keys. They are created
 * readable by you only, and tightened if they already exist with looser permissions.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  } catch {
    // not ours to change; nothing else to do
  }
}
