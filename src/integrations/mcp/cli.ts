import fs from 'node:fs';
import path from 'node:path';
import { unwrapConfig, wrapConfig, type WrapResult } from './config.js';
import { runGateway } from './gateway.js';

const USAGE = `Run an MCP server behind belayd:
  belayd mcp --name <server> -- <command> [args...]

Rewrite an mcpServers config file (.mcp.json, Cursor mcp.json, Gemini settings.json):
  belayd mcp wrap <file>
  belayd mcp unwrap <file>
`;

/** `belayd mcp ...`. Parsed by hand because everything after `--` belongs to the server. */
export async function mcpCommand(args: string[]): Promise<number> {
  const [first, second] = args;
  if (first === 'wrap' || first === 'unwrap') {
    if (!second) {
      process.stderr.write(USAGE);
      return 64;
    }
    try {
      const file = path.resolve(second);
      const r =
        first === 'wrap'
          ? wrapConfig(file, { nodePath: process.execPath, binPath: binPath() })
          : unwrapConfig(file);
      report(first, r);
      return 0;
    } catch (err) {
      process.stderr.write(`belayd mcp ${first}: ${(err as Error).message}\n`);
      return 1;
    }
  }

  const sep = args.indexOf('--');
  const before = sep >= 0 ? args.slice(0, sep) : [];
  const command = sep >= 0 ? args.slice(sep + 1) : args;
  const n = before.indexOf('--name');
  const name = n >= 0 ? before[n + 1] : undefined;
  if (!command[0] || first === '--help' || first === '-h') {
    process.stderr.write(USAGE);
    return command[0] ? 0 : 64;
  }
  return runGateway({
    name: name ?? path.basename(command[0]).replace(/[^A-Za-z0-9_-]/g, '_'),
    command: command[0],
    args: command.slice(1),
    env: process.env,
    cwd: process.cwd(),
    binPath: binPath(),
  });
}

function report(verb: string, r: WrapResult): void {
  const done = verb === 'wrap' ? 'Now running behind belayd' : 'No longer behind belayd';
  if (r.wrapped.length > 0) process.stdout.write(`${done}: ${r.wrapped.join(', ')}\n`);
  for (const s of r.skipped) process.stdout.write(`  skipped ${s.name} (${s.why})\n`);
  if (r.wrapped.length === 0) process.stdout.write(`Nothing to change in ${r.file}\n`);
  if (r.backup) process.stdout.write(`Previous file saved to ${r.backup}\n`);
}

function binPath(): string {
  const script = process.argv[1] ?? '';
  try {
    return fs.realpathSync(script);
  } catch {
    return path.resolve(script);
  }
}
