import { spawn } from 'node:child_process';

/**
 * Best-effort desktop notification. Never throws and never waits: a missing
 * notifier must not slow down or break a hook.
 */
export function notify(title: string, message: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.BELAYD_NO_NOTIFY === '1') return;
  try {
    if (process.platform === 'darwin') {
      const script = `display notification ${appleString(message)} with title ${appleString(title)} sound name "Ping"`;
      detached('osascript', ['-e', script]);
    } else if (process.platform === 'linux') {
      detached('notify-send', ['--app-name=belayd', title, message]);
    }
  } catch {
    // no notifier available
  }
}

function detached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

function appleString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
