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

/**
 * Pairs a tool call's before and after events for agents that send no call id (Copilot
 * CLI, Gemini CLI), so undo can still tell what each step changed. A call is known by
 * its tool and input; identical calls pair in order. Append-only, like the writes above.
 */
function callsFile(belaydHome: string, session: string): string {
  return file(belaydHome, session).replace(/\.txt$/, '.calls');
}

function callKey(tool: string, input: unknown): string {
  return crypto
    .createHash('sha256')
    .update(`${tool}\0${JSON.stringify(input)}`)
    .digest('hex')
    .slice(0, 16);
}

/** Starts a call and returns the id its after event will get. */
export function startCall(
  belaydHome: string,
  session: string,
  tool: string,
  input: unknown,
): string {
  const key = callKey(tool, input);
  const id = `${key}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    const f = callsFile(belaydHome, session);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.appendFileSync(f, `+ ${key} ${id}\n`, { mode: 0o600 });
  } catch {
    // only costs undo for this step
  }
  return id;
}

/** The id of the oldest started call with this tool and input that has not finished. */
export function finishCall(
  belaydHome: string,
  session: string,
  tool: string,
  input: unknown,
): string | undefined {
  const key = callKey(tool, input);
  try {
    const f = callsFile(belaydHome, session);
    const open: string[] = [];
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const [op, k, id] = line.split(' ');
      if (k !== key || !id) continue;
      if (op === '+') open.push(id);
      else if (op === '-') open.splice(open.indexOf(id), open.includes(id) ? 1 : 0);
    }
    const id = open[0];
    if (id) fs.appendFileSync(f, `- ${key} ${id}\n`);
    return id;
  } catch {
    return undefined;
  }
}
