import { spawn } from 'node:child_process';

export type DialogAnswer = 'allow' | 'deny' | 'timeout' | 'unavailable';

/**
 * Asks with a native OS dialog shown by the waiting hook process itself. Unlike the
 * console or the web page, the answer never goes through a file, so another program
 * running as you cannot forge it by writing one.
 *
 * BELAYD_DIALOG=allow|deny|timeout answers without showing anything (test suite only).
 */
export function askDialog(
  title: string,
  message: string,
  timeoutSec: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DialogAnswer> {
  const fake = env.BELAYD_DIALOG;
  if (fake === 'allow' || fake === 'deny' || fake === 'timeout') return Promise.resolve(fake);

  const seconds = Math.max(1, Math.floor(timeoutSec));
  if (process.platform === 'darwin') {
    const script =
      `display dialog ${appleString(message)} with title ${appleString(title)} ` +
      `buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" with icon caution ` +
      `giving up after ${seconds}`;
    return run('osascript', ['-e', script], (code, out) => {
      if (code !== 0) return 'deny'; // Deny is the cancel button; a killed dialog is a no too
      if (/gave up:true/.test(out)) return 'timeout';
      return /button returned:Allow/.test(out) ? 'allow' : 'deny';
    });
  }
  if (process.platform === 'linux') {
    return run(
      'zenity',
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
      (code) => (code === 0 ? 'allow' : code === 5 ? 'timeout' : 'deny'),
    );
  }
  return Promise.resolve('unavailable');
}

function run(
  cmd: string,
  args: string[],
  interpret: (code: number | null, stdout: string) => DialogAnswer,
): Promise<DialogAnswer> {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve('unavailable');
      return;
    }
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', () => resolve('unavailable'));
    child.on('close', (code) => resolve(interpret(code, out)));
  });
}

function appleString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
