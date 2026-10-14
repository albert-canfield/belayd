import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { geminiDialect, toGeminiAction } from '../../src/agents/gemini/hook.js';
import { geminiSetup } from '../../src/agents/gemini/setup.js';
import { handleToolHook } from '../../src/hook/handle.js';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-gemini-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  env = {
    HOME: path.join(dir, 'home'),
    BELAYD_HOME: path.join(dir, 'belayd-home'),
    GEMINI_CLI_HOME: path.join(dir, 'gemini-home'),
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('Gemini CLI tool mapping', () => {
  it.each([
    ['run_shell_command', { command: 'ls' }, { kind: 'shell', command: 'ls' }],
    [
      'run_shell_command',
      { command: 'ls', dir_path: '/x y' },
      { kind: 'shell', command: "cd '/x y' && ls" },
    ],
    ['read_file', { file_path: '/a/b.ts' }, { kind: 'read', path: '/a/b.ts' }],
    [
      'write_file',
      { file_path: '/a/c.ts', content: 'x' },
      { kind: 'write', path: '/a/c.ts', content: 'x' },
    ],
    [
      'replace',
      { file_path: '/a/c.ts', old_string: 'a', new_string: 'b' },
      { kind: 'write', path: '/a/c.ts' },
    ],
    [
      'read_many_files',
      { include: ['README.md', '.env'] },
      { kind: 'read', path: '/a', glob: '{README.md,.env}' },
    ],
    [
      'grep_search',
      { pattern: 'x', include_pattern: '*.env' },
      { kind: 'read', path: '/a', glob: '*.env' },
    ],
    [
      'web_fetch',
      { prompt: 'summarise https://example.com/x please' },
      { kind: 'fetch', url: 'https://example.com/x' },
    ],
  ])('%s', (tool, input, action) => {
    expect(toGeminiAction(tool, input, '/a')).toEqual(action);
  });

  it('reads MCP tools', () => {
    expect(toGeminiAction('mcp_github_create_issue', { title: 'x' }, '/a')).toEqual({
      kind: 'mcp',
      server: 'github',
      tool: 'create_issue',
      args: { title: 'x' },
    });
  });
});

describe('Gemini CLI hook', () => {
  const call = (payload: Record<string, unknown>) =>
    handleToolHook(JSON.stringify(payload), { env, timeoutSec: 30 }, geminiDialect);

  it('denies a secret read in the form Gemini CLI reads', async () => {
    const r = await call({
      hook_event_name: 'BeforeTool',
      cwd: dir,
      session_id: 's',
      tool_name: 'read_many_files',
      tool_input: { include: ['src/**', '.env'] },
    });
    expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'deny' });
    expect(r.exitCode).toBe(0);
  });

  it('treats an AfterTool with an error as a failed call', () => {
    const e = geminiDialect.parse(
      {
        hook_event_name: 'AfterTool',
        tool_name: 'run_shell_command',
        tool_response: { error: 'x' },
      },
      undefined,
    );
    expect(e.phase).toBe('failed');
  });
});

describe('Gemini CLI setup', () => {
  const opts = (global = false) => ({
    workspace: dir,
    global,
    env,
    nodePath: process.execPath,
    binPath: '/opt/belayd/dist/bin.js',
  });

  it('installs matcher groups with a regex matcher and millisecond timeouts', () => {
    const plan = geminiSetup.plan(opts());
    expect(plan.file).toBe(path.join(dir, '.gemini', 'settings.json'));
    plan.apply();
    const hooks = JSON.parse(fs.readFileSync(plan.file, 'utf8')).hooks;
    expect(Object.keys(hooks).sort()).toEqual(['AfterTool', 'BeforeTool']);
    expect(hooks.BeforeTool[0].matcher).toBe('.*');
    expect(hooks.BeforeTool[0].hooks[0]).toMatchObject({
      name: 'belayd',
      type: 'command',
      timeout: 180_000,
    });
    expect(hooks.BeforeTool[0].hooks[0].command).toMatch(/hook gemini --timeout 180 \|\| \{/);
    expect(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '.gemini/settings.json',
    );
  });

  it('warns when the project settings file is committed', () => {
    fs.mkdirSync(path.join(dir, '.gemini'));
    fs.writeFileSync(path.join(dir, '.gemini', 'settings.json'), '{}');
    execFileSync('git', ['add', '.gemini/settings.json'], { cwd: dir });
    expect(geminiSetup.plan(opts()).warnings.join(' ')).toMatch(/committed.*--global/);
  });

  it('installs user hooks under GEMINI_CLI_HOME and removes only its own', () => {
    const file = path.join(env.GEMINI_CLI_HOME!, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const theirs = { matcher: 'write_file', hooks: [{ type: 'command', command: './check.sh' }] };
    fs.writeFileSync(file, JSON.stringify({ hooks: { BeforeTool: [theirs] }, theme: 'x' }));
    geminiSetup.plan(opts(true)).apply();
    for (const r of geminiSetup.uninstall(opts(true))) r.apply();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      hooks: { BeforeTool: [theirs] },
      theme: 'x',
    });
  });
});
