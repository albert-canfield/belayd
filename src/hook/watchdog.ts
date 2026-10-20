import path from 'node:path';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { belaydHome } from '../util/paths.js';

/**
 * A guard against hangs. A timer on the main thread cannot stop a stuck regular
 * expression or a blocking read, because neither ever yields to it, so the guard runs on
 * its own thread: past the deadline it prints the reason and kills the process. The
 * agent then sees a failed hook, which belayd's installed hooks turn into a block,
 * instead of a timeout the agent might treat as "go ahead".
 */
export interface Watchdog {
  /** Moves the deadline to `ms` after the watchdog started. */
  extend(ms: number): void;
  stop(): void;
}

/** Checking a call takes milliseconds. Past this, something is stuck and the call is blocked. */
const CHECK_DEADLINE_MS = 20_000;
/** Older installs used a 30 second hook timeout and did not pass --timeout. */
export const DEFAULT_TIMEOUT_SEC = 30;

export const HANG_MESSAGE =
  'belayd took too long to check this call, so it is blocked. Ask the user to run `belayd doctor`.';

/** How long a check may take before the watchdog blocks it, for a hook timeout in seconds. */
export function checkDeadlineMs(timeoutSec: number | undefined): number {
  return Math.min(CHECK_DEADLINE_MS, ((timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000) / 2);
}

/** The `--timeout` a hook was installed with, in seconds. */
export function hookTimeoutSec(args: string[]): number | undefined {
  const i = args.indexOf('--timeout');
  return (i >= 0 ? Number(args[i + 1]) : NaN) || undefined;
}

/** The watchdog for one `belayd hook` check. */
export function startHookWatchdog(args: string[], env: NodeJS.ProcessEnv): Watchdog {
  return startWatchdog(
    checkDeadlineMs(hookTimeoutSec(args)),
    HANG_MESSAGE,
    path.join(belaydHome(env), 'errors.log'),
  );
}

const SOURCE = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const cell = new Int32Array(workerData.buffer);
for (;;) {
  const deadline = Atomics.load(cell, 0);
  if (deadline < 0) break;
  const wait = deadline - (Date.now() - workerData.base);
  if (wait <= 0) {
    try { fs.writeSync(2, workerData.message + '\\n'); } catch {}
    try {
      fs.appendFileSync(workerData.log, new Date().toISOString() + ' watchdog: ' + workerData.message + '\\n');
    } catch {}
    process.kill(process.pid, 'SIGKILL');
  }
  Atomics.wait(cell, 0, deadline, wait);
}
`;

/**
 * A thread takes about 15 ms to start, and one still starting holds up the process exit
 * for the rest of that time. `belayd hook` therefore starts the watchdog before it loads
 * the checking code, so the thread is ready long before the check is done.
 */
export function startWatchdog(ms: number, message: string, logFile: string): Watchdog {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  cell[0] = Math.max(1, Math.floor(ms));
  const set = (value: number) => {
    Atomics.store(cell, 0, value);
    Atomics.notify(cell, 0);
  };
  try {
    const worker = new Worker(SOURCE, {
      eval: true,
      workerData: { buffer: cell.buffer, base: Date.now(), message, log: logFile },
      // The thread only waits and writes to fd 2: no copy of the environment, no piped
      // stdio, no fd tracking. Each of these costs start-up and exit time.
      env: SHARE_ENV,
      stdout: true,
      stderr: true,
      trackUnmanagedFds: false,
    });
    worker.on('error', () => {});
    worker.unref();
  } catch {
    // no threads available: run unguarded rather than not at all
  }
  return {
    extend: (next) => set(Math.max(1, Math.floor(next))),
    stop: () => set(-1),
  };
}
