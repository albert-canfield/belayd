import { Worker } from 'node:worker_threads';

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
