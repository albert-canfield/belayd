import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { belayd, bin, sandbox, type Sandbox } from './helpers.js';

const server = fileURLToPath(new URL('../fixtures/fake-mcp-server.mjs', import.meta.url));

let sb: Sandbox;
let gw: ChildProcessWithoutNullStreams;
let replies: Map<number, Record<string, unknown>>;
let nextId = 1;

beforeEach(() => {
  sb = sandbox();
  fs.writeFileSync(
    path.join(sb.project, 'belayd.yaml'),
    'version: 1\napproval: { channels: [tty], notify: false }\n',
  );
  fs.writeFileSync(path.join(sb.project, '.env'), 'SECRET=belayd-mcp-canary\n');
  gw = spawn(process.execPath, [bin, 'mcp', '--name', 'fs', '--', process.execPath, server], {
    cwd: sb.project,
    env: sb.env,
  });
  replies = new Map();
  readline.createInterface({ input: gw.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    replies.set(msg.id, msg);
  });
});
afterEach(async () => {
  // Let the gateway finish its last audit write before the folder goes away.
  const exited = new Promise((res) => gw.once('exit', res));
  gw.stdin.end();
  gw.kill();
  await exited;
  sb.cleanup();
});

async function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = nextId++;
  gw.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  for (let i = 0; i < 750; i++) {
    const r = replies.get(id);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`no reply to ${method}`);
}
const call = (name: string, args: unknown) => rpc('tools/call', { name, arguments: args });
const text = (r: Record<string, unknown>) =>
  (r.result as { content: { text: string }[] }).content[0]!.text;

describe('belayd mcp gateway (built binary)', () => {
  it('passes the handshake and harmless calls through', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    });
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('fake');
    const list = await rpc('tools/list', {});
    expect((list.result as { tools: unknown[] }).tools).toHaveLength(4);
    expect(text(await call('echo', { message: 'hi' }))).toBe('ok echo');
  });

  it('answers a blocked call itself, as a tool error the model can read', async () => {
    const r = await call('read_file', { path: path.join(sb.project, '.env') });
    expect((r.result as { isError: boolean }).isError).toBe(true);
    expect(text(r)).toMatch(/Blocked by belayd: .*secrets/);
    expect(JSON.stringify(r)).not.toMatch(/belayd-mcp-canary/);
  });

  it('checks shell-style tools like any shell command', async () => {
    const r = await call('execute_command', { command: 'cd / && rm -rf *' });
    expect(text(r)).toMatch(/Blocked by belayd/);
  });

  it('adds resultType for clients on the 2026-07-28 protocol', async () => {
    await rpc('initialize', { protocolVersion: '2026-07-28', capabilities: {} });
    const r = await call('read_file', { path: '.env' });
    expect((r.result as { resultType?: string }).resultType).toBe('complete');
  });

  it('holds a risky call until someone approves it', async () => {
    // Agent hook settings always need a person, wherever they live.
    const pending = call('write_file', {
      path: path.join(sb.env.HOME!, '.claude', 'settings.json'),
      content: '{}',
    });
    let id: string | undefined;
    for (let i = 0; i < 100 && !id; i++) {
      await new Promise((res) => setTimeout(res, 50));
      id = JSON.parse(belayd(sb, ['approve', '--json']).stdout)[0]?.id;
    }
    expect(id).toBeDefined();
    belayd(sb, ['approve', id!, '--allow']);
    expect(text(await pending)).toBe('ok write_file');
  });

  it('records calls and makes file changes undoable', async () => {
    const file = path.join(sb.project, 'src', 'gen.ts');
    expect(text(await call('write_file', { path: file, content: 'generated\n' }))).toBe(
      'ok write_file',
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('generated\n');
    await new Promise((res) => setTimeout(res, 300));
    const replay = belayd(sb, ['replay']);
    expect(replay.stdout).toMatch(/MCP/);
    expect(replay.stdout).toMatch(/A src\/gen\.ts/);
    expect(belayd(sb, ['undo']).status).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('belayd mcp wrap / unwrap', () => {
  it('wraps stdio servers, leaves remote ones alone, and unwraps back', () => {
    const file = path.join(sb.project, '.mcp.json');
    const original = {
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { X: '1' },
        },
        remote: { type: 'http', url: 'https://mcp.example.com' },
      },
    };
    fs.writeFileSync(file, JSON.stringify(original));
    const w = belayd(sb, ['mcp', 'wrap', file]);
    expect(w.stdout).toMatch(/Now running behind belayd: github/);
    const wrapped = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(wrapped.mcpServers.github.args.slice(1, 6)).toEqual([
      'mcp',
      '--name',
      'github',
      '--',
      'npx',
    ]);
    expect(wrapped.mcpServers.github.env).toEqual({ X: '1' });
    expect(wrapped.mcpServers.remote).toEqual(original.mcpServers.remote);
    belayd(sb, ['mcp', 'unwrap', file]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(original);
  });
});
