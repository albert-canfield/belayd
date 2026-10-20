import { findAgent, hookAgents } from '../agents/registry.js';
import type { Dialect } from '../agents/types.js';
import type { HookResult } from './types.js';
import { hookTimeoutSec, startHookWatchdog, type Watchdog } from './watchdog.js';

/**
 * Entry point for `belayd hook <agent> [--timeout s] [--event name]`. Reads the agent's
 * JSON from stdin, writes the decision the way that agent reads it. Any failure
 * becomes a block, never a silent allow.
 */
export async function runHook(args: string[]): Promise<void> {
  const option = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const timeoutSec = hookTimeoutSec(args);
  const event = option('--event');
  let result: HookResult;
  let watchdog: Watchdog | undefined;
  try {
    const agent = findAgent(args[0] ?? '');
    if (!agent?.dialect) {
      result = blockUnknown(`unknown agent "${args[0] ?? ''}"`);
    } else {
      const [installed, input] = await Promise.all([agent.dialect(), readStdin()]);
      const payload = parsePayload(input);
      const dialect = await dialectFor(installed, payload);
      // Only a call that has yet to run can be blocked, so only its check is guarded.
      // The watchdog starts before the checking code loads: its thread is then ready by
      // the time the check ends, instead of holding up the exit (see watchdog.ts).
      if (phaseOf(dialect, payload, event) === 'pre')
        watchdog = startHookWatchdog(args, process.env);
      const { handleToolHook } = await import('./handle.js');
      result = await handleToolHook(
        input,
        {
          env: process.env,
          ...(timeoutSec ? { timeoutSec } : {}),
          ...(event ? { event } : {}),
          ...(watchdog ? { watchdog } : {}),
        },
        dialect,
      );
    }
  } catch (err) {
    result = blockUnknown((err as Error)?.message ?? String(err));
  } finally {
    watchdog?.stop();
  }
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
}

/**
 * Exit code 2 blocks in every agent that follows the Claude Code hook dialect,
 * and stderr becomes the reason the agent sees.
 */
function blockUnknown(message: string): HookResult {
  return {
    stdout: '',
    stderr: `belayd failed and is blocking this action to be safe: ${message}. Run \`belayd doctor\` to find out why.\n`,
    exitCode: 2,
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/**
 * The dialect for what the hook was actually sent. Usually the installed one; another
 * when an agent runs a hook command written for a different agent (Gemini CLI can
 * import Claude Code's hooks). Unreadable input stays with the installed dialect,
 * which blocks it.
 */
async function dialectFor(
  installed: Dialect,
  payload: Record<string, unknown> | undefined,
): Promise<Dialect> {
  if (!payload) return installed;
  if (!installed.recognises || installed.recognises(payload)) return installed;
  for (const agent of hookAgents()) {
    const other = await agent.dialect!();
    if (other.recognises?.(payload)) return other;
  }
  return installed;
}

function parsePayload(raw: string): Record<string, unknown> | undefined {
  try {
    const payload = JSON.parse(raw) as unknown;
    if (payload && typeof payload === 'object' && !Array.isArray(payload))
      return payload as Record<string, unknown>;
  } catch {
    // unreadable: the check blocks it
  }
  return undefined;
}

/** The phase the check will see. Anything unclear counts as `pre`, which is guarded. */
function phaseOf(
  dialect: Dialect,
  payload: Record<string, unknown> | undefined,
  event: string | undefined,
): string {
  if (!payload) return 'pre';
  try {
    return dialect.parse(payload, event).phase;
  } catch {
    return 'pre';
  }
}
