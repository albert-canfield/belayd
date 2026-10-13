import { handleClaudeCode } from '../integrations/claude-code/hook.js';
import type { HookResult } from './types.js';

/**
 * Entry point for `belayd hook <agent>`. Reads the agent's JSON from stdin, writes the
 * decision to stdout. Any failure becomes a block, never a silent allow.
 */
export async function runHook(args: string[]): Promise<void> {
  const agent = args[0] ?? '';
  let result: HookResult;
  try {
    const input = await readStdin();
    switch (agent) {
      case 'claude-code':
        result = await handleClaudeCode(input, { env: process.env });
        break;
      default:
        result = blockUnknown(`unknown agent "${agent}"`);
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
