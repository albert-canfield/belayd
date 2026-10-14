import { findAgent, hookAgents } from '../agents/registry.js';
import type { Dialect } from '../agents/types.js';
import { handleToolHook } from './handle.js';
import type { HookResult } from './types.js';

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
  const timeoutSec = Number(option('--timeout')) || undefined;
  const event = option('--event');
  let result: HookResult;
  try {
    const agent = findAgent(args[0] ?? '');
    if (!agent?.dialect) {
      result = blockUnknown(`unknown agent "${args[0] ?? ''}"`);
    } else {
      const [installed, input] = await Promise.all([agent.dialect(), readStdin()]);
      const dialect = await dialectFor(installed, input);
      result = await handleToolHook(
        input,
        {
          env: process.env,
          ...(timeoutSec ? { timeoutSec } : {}),
          ...(event ? { event } : {}),
        },
        dialect,
      );
    }
  } catch (err) {
    result = blockUnknown((err as Error)?.message ?? String(err));
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
async function dialectFor(installed: Dialect, raw: string): Promise<Dialect> {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return installed;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return installed;
  const p = payload as Record<string, unknown>;
  if (!installed.recognises || installed.recognises(p)) return installed;
  for (const agent of hookAgents()) {
    const other = await agent.dialect!();
    if (other.recognises?.(p)) return other;
  }
  return installed;
}
