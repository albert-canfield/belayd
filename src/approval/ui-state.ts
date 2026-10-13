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

/** The secret that unlocks the local approval page. Readable only by you (mode 600). */
export function uiToken(belaydHome: string): string {
  const file = path.join(belaydHome, 'ui-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  } catch {
    // create it below
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(belaydHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
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

export function uiUrl(state: UiState, token?: string): string {
  return `http://127.0.0.1:${state.port}/${token ? `?t=${token}` : ''}`;
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
