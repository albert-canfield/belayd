import fs from 'node:fs';
import { readSettings, writeSettings } from '../../agents/common.js';

/**
 * Wraps the stdio servers in an `mcpServers` config (Claude Code .mcp.json, Cursor
 * mcp.json, Gemini settings.json) so they run behind `belayd mcp`. Remote servers
 * (url, httpUrl) are left alone: they are covered by the agent's hooks instead.
 */

interface Server {
  command?: string;
  args?: string[];
  url?: string;
  httpUrl?: string;
  [key: string]: unknown;
}

export interface WrapResult {
  file: string;
  wrapped: string[];
  skipped: { name: string; why: string }[];
  backup?: string;
}

export function wrapConfig(file: string, opts: { nodePath: string; binPath: string }): WrapResult {
  return edit(file, (name, server) => {
    if (!server.command)
      return { why: server.url || server.httpUrl ? 'remote server' : 'no command' };
    if (isWrapped(server)) return { why: 'already wrapped' };
    return {
      next: {
        ...server,
        command: opts.nodePath,
        args: [opts.binPath, 'mcp', '--name', name, '--', server.command, ...(server.args ?? [])],
      },
    };
  });
}

export function unwrapConfig(file: string): WrapResult {
  return edit(file, (_name, server) => {
    if (!isWrapped(server)) return { why: 'not wrapped' };
    const args = server.args ?? [];
    const sep = args.indexOf('--');
    const [command, ...rest] = args.slice(sep + 1);
    if (!command) return { why: 'cannot find the original command' };
    return { next: { ...server, command, args: rest } };
  });
}

export function isWrapped(server: Server): boolean {
  const args = server.args ?? [];
  return args[1] === 'mcp' && args[2] === '--name' && args.includes('--');
}

function edit(
  file: string,
  change: (name: string, server: Server) => { next?: Server; why?: string },
): WrapResult {
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist`);
  const settings = readSettings(file);
  const servers = settings.mcpServers as Record<string, Server> | undefined;
  const result: WrapResult = { file, wrapped: [], skipped: [] };
  if (!servers || typeof servers !== 'object') return result;
  const next: Record<string, Server> = { ...servers };
  for (const [name, server] of Object.entries(servers)) {
    const r = change(name, server ?? {});
    if (r.next) {
      next[name] = r.next;
      result.wrapped.push(name);
    } else result.skipped.push({ name, why: r.why ?? '' });
  }
  if (result.wrapped.length > 0) {
    const backup = writeSettings(file, { ...settings, mcpServers: next });
    if (backup) result.backup = backup;
  }
  return result;
}
