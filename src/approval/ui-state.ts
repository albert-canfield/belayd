import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** "BELAY" on a phone keypad. */
export const DEFAULT_PORT = 23529;

export interface UiState {
  pid: number;
  port: number;
  startedAt: number;
}

export function readUiState(belaydHome: string): UiState | undefined {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(belaydHome, 'ui.json'), 'utf8')) as UiState;
    process.kill(state.pid, 0);
    return state;
  } catch {
    return undefined;
  }
}

export function writeUiState(belaydHome: string, state: UiState): void {
  fs.mkdirSync(belaydHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(belaydHome, 'ui.json'), JSON.stringify(state), { mode: 0o600 });
}

export function clearUiState(belaydHome: string, pid: number): void {
  const current = readUiStateRaw(belaydHome);
  if (current?.pid === pid) fs.rmSync(path.join(belaydHome, 'ui.json'), { force: true });
}

function readUiStateRaw(belaydHome: string): UiState | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(belaydHome, 'ui.json'), 'utf8')) as UiState;
  } catch {
    return undefined;
  }
}

/** Starts the approval page in the background unless it is already running. */
export function ensureUiServer(opts: {
  belaydHome: string;
  binPath: string;
  port: number;
  env: NodeJS.ProcessEnv;
}): void {
  if (readUiState(opts.belaydHome)) return;
  const child = spawn(
    process.execPath,
    [opts.binPath, 'ui', '--serve', '--port', String(opts.port)],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...opts.env, BELAYD_HOME: opts.belaydHome },
    },
  );
  child.on('error', () => {});
  child.unref();
}

const LINK_TTL_MS = 2 * 60_000;

/**
 * A one-time key for the link `belayd ui` opens. It works once, for two minutes, and is
 * then swapped for a random session cookie, so nothing long-lived ends up in browser
 * history or on a command line.
 */
export function createLinkKey(belaydHome: string): string {
  const key = crypto.randomBytes(24).toString('hex');
  const dir = path.join(belaydHome, 'ui-links');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, key), String(Date.now() + LINK_TTL_MS), { mode: 0o600 });
  return key;
}

/** Uses up a link key. True only the first time, and only before it expires. */
export function consumeLinkKey(belaydHome: string, key: string): boolean {
  if (!/^[a-f0-9]{48}$/.test(key)) return false;
  const file = path.join(belaydHome, 'ui-links', key);
  let expires: number;
  try {
    expires = Number(fs.readFileSync(file, 'utf8'));
    fs.rmSync(file);
  } catch {
    return false;
  }
  return Date.now() < expires;
}

export function linkUrl(state: UiState, key: string): string {
  return `http://127.0.0.1:${state.port}/?k=${key}`;
}
