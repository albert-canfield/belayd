import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Remembers which files the agent changed in a session, so belayd can notice when it
 * then runs one of them (`npm test` after editing package.json, `make` after editing
 * the Makefile, `git commit` after adding a hook). One path per line, appended, so
 * parallel tool calls never overwrite each other.
 */

function file(belaydHome: string, session: string): string {
  const id = crypto.createHash('sha256').update(session).digest('hex').slice(0, 20);
  return path.join(belaydHome, 'sessions', `${id}.txt`);
}

export function sessionWrites(belaydHome: string, session: string): Set<string> {
  try {
    return new Set(fs.readFileSync(file(belaydHome, session), 'utf8').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

export function addSessionWrites(belaydHome: string, session: string, paths: string[]): void {
  if (paths.length === 0) return;
  try {
    const f = file(belaydHome, session);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.appendFileSync(f, `${[...new Set(paths)].join('\n')}\n`, { mode: 0o600 });
  } catch {
    // only costs this one feature
  }
}
