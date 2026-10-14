import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

export type DialogAnswer = 'allow' | 'deny' | 'timeout' | 'unavailable';

export interface Dialog {
  answer: Promise<DialogAnswer>;
  /** Closes the dialog if it is still open, once the call was answered some other way. */
  close(): void;
}

type FakeDialog = (title: string, message: string, timeoutSec: number) => Promise<DialogAnswer>;
let fake: FakeDialog | undefined;

/** Replaces the real dialog in the test suite. Never read from the environment. */
export function setDialogForTests(f: FakeDialog | undefined): void {
  fake = f;
}

/**
 * Programs are run from fixed system paths, never looked up on PATH: a fake `osascript`
 * earlier on PATH could otherwise print "Allow" without anyone seeing a thing.
 */
const OSASCRIPT = '/usr/bin/osascript';
const ZENITY = ['/usr/bin/zenity', '/bin/zenity'];

/**
 * Asks with a native OS dialog shown by the waiting hook process itself. Unlike the
 * console or the web page, the answer never goes through a file, so another program
 * running as you cannot forge it by writing one.
 */
export function askDialog(
  title: string,
  message: string,
  timeoutSec: number,
  env: NodeJS.ProcessEnv = process.env,
): Dialog {
  if (fake) return { answer: fake(title, message, timeoutSec), close: () => {} };

  const seconds = Math.max(1, Math.floor(timeoutSec));
  if (process.platform === 'darwin') {
    const script =
      `display dialog ${appleString(message)} with title ${appleString(title)} ` +
      `buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" with icon caution ` +
      `giving up after ${seconds}`;
    return run(OSASCRIPT, ['-e', script], (code, out, err) => {
      if (code === 0) {
        if (/gave up:true/.test(out)) return 'timeout';
        return /button returned:Allow/.test(out) ? 'allow' : 'deny';
      }
      // Deny is the cancel button, reported as error -128. Anything else (no screen,
      // over SSH, killed) means the dialog could not ask, not that someone said no.
      return /-128/.test(err) ? 'deny' : 'unavailable';
    });
  }
  if (process.platform === 'linux') {
    const zenity = ZENITY.find((p) => fs.existsSync(p));
    if (!zenity || !(env.DISPLAY || env.WAYLAND_DISPLAY)) return unavailable();
    return run(
      zenity,
      [
        '--question',
        `--title=${title}`,
        `--text=${message}`,
        '--ok-label=Allow',
        '--cancel-label=Deny',
        `--timeout=${seconds}`,
        '--no-markup',
        '--width=520',
      ],
      (code, _out, err) => {
        if (code === 0) return 'allow';
        if (code === 5) return 'timeout';
        if (code === 1 && !/cannot open display|Gtk-WARNING/i.test(err)) return 'deny';
        return 'unavailable';
      },
    );
  }
  return unavailable();
}

function unavailable(): Dialog {
  return { answer: Promise.resolve('unavailable'), close: () => {} };
}

function run(
  cmd: string,
  args: string[],
  interpret: (code: number | null, stdout: string, stderr: string) => DialogAnswer,
): Dialog {
  let child: ChildProcess;
  try {
    child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return unavailable();
  }
  let out = '';
  let err = '';
  let closed = false;
  const answer = new Promise<DialogAnswer>((resolve) => {
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', () => resolve('unavailable'));
    child.on('close', (code) => resolve(closed ? 'unavailable' : interpret(code, out, err)));
  });
  return {
    answer,
    close: () => {
      if (closed || child.exitCode !== null) return;
      closed = true;
      child.kill();
    },
  };
}

function appleString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
