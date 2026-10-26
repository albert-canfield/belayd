import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OPENCODE_MARK,
  opencodeDialect,
  toOpencodeAction,
} from '../../src/agents/opencode/hook.js';
import {
  opencodeConfigDir,
  opencodeSetup,
  opencodeTarget,
  pluginSource,
} from '../../src/agents/opencode/setup.js';
import { handleToolHook } from '../../src/hook/handle.js';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-opencode-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  env = {
    HOME: path.join(dir, 'home'),
    BELAYD_HOME: path.join(dir, 'belayd-home'),
    XDG_CONFIG_HOME: path.join(dir, 'xdg'),
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('OpenCode tool mapping', () => {
  it.each([
    ['bash', { command: 'ls' }, { kind: 'shell', command: 'ls' }],
    ['bash', { command: 'ls', workdir: '/x y' }, { kind: 'shell', command: "cd '/x y' && ls" }],
    ['read', { filePath: '/a/b.ts' }, { kind: 'read', path: '/a/b.ts' }],
    [
      'write',
      { filePath: '/a/c.ts', content: 'x' },
      { kind: 'write', path: '/a/c.ts', content: 'x' },
    ],
    [
      'edit',
      { filePath: '/a/c.ts', oldString: 'a', newString: 'b' },
      { kind: 'write', path: '/a/c.ts' },
    ],
    [
      'grep',
      { pattern: 'x', path: '/a', include: '*.env' },
      { kind: 'read', path: '/a', glob: '*.env' },
    ],
    ['glob', { pattern: '**/*.ts' }, { kind: 'read', path: '/cwd' }],
    [
      'webfetch',
      { url: 'https://example.com', format: 'text' },
      { kind: 'fetch', url: 'https://example.com' },
    ],
    ['todowrite', { todos: [] }, { kind: 'tool', name: 'todowrite', input: { todos: [] } }],
    [
      'github_create_issue',
      { title: 't' },
      { kind: 'mcp', server: 'github', tool: 'create_issue', args: { title: 't' } },
    ],
  ])('%s', (tool, input, action) => {
    expect(toOpencodeAction(tool, input, '/cwd')).toEqual(action);
  });

  it('reads apply_patch like Codex, and treats an unreadable patch as code it cannot see', () => {
    const patch = '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\n';
    expect(toOpencodeAction('apply_patch', { patchText: patch }, '/cwd')).toMatchObject({
      kind: 'patch',
      files: [{ path: 'a.txt', op: 'add' }],
    });
    expect(toOpencodeAction('apply_patch', { patchText: 'garbage' }, '/cwd')).toEqual({
      kind: 'shell',
      command: '$UNREADABLE_PATCH',
    });
  });
});

describe('OpenCode hook', () => {
  const call = (payload: Record<string, unknown>) =>
    handleToolHook(JSON.stringify(payload), { env, timeoutSec: 30 }, opencodeDialect);

  it('denies a secret read and answers in the shape the plugin reads', async () => {
    const r = await call({
      source: OPENCODE_MARK,
      event: 'before',
      tool: 'bash',
      sessionID: 's',
      callID: 'c1',
      directory: dir,
      args: { command: 'cat .env' },
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'deny' });
  });

  it('says nothing about a harmless call', async () => {
    const r = await call({ ...opencodeDialect.sample('pre', 'ls', dir) });
    expect(r).toEqual({ stdout: '', exitCode: 0 });
  });
});

describe('OpenCode setup', () => {
  const opts = (global: boolean) => ({
    workspace: dir,
    global,
    env,
    nodePath: process.execPath,
    binPath: path.join(dir, 'bin.js'),
  });

  it('writes a project plugin, keeps it out of Git and removes only its own', () => {
    fs.writeFileSync(path.join(dir, 'bin.js'), '');
    const plan = opencodeSetup.plan(opts(false));
    expect(plan.file).toBe(path.join(dir, '.opencode', 'plugins', 'belayd.js'));
    plan.apply();
    const source = fs.readFileSync(plan.file, 'utf8');
    expect(source).toContain(OPENCODE_MARK);
    expect(source).toContain(JSON.stringify(process.execPath));
    expect(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '.opencode/plugins/belayd.js',
    );
    expect(opencodeSetup.doctor(opts(false))[0]).toMatchObject({ status: 'ok' });

    const removals = opencodeSetup.uninstall(opts(false));
    expect(removals).toHaveLength(1);
    removals[0]!.apply();
    expect(fs.existsSync(plan.file)).toBe(false);
  });

  it('writes a user plugin under XDG_CONFIG_HOME', () => {
    const plan = opencodeSetup.plan(opts(true));
    expect(plan.file).toBe(path.join(opencodeConfigDir(env), 'plugins', 'belayd.js'));
    expect(opencodeConfigDir(env)).toBe(path.join(dir, 'xdg', 'opencode'));
  });

  it('backs up a plugin file that is not its own, and leaves it alone on uninstall', () => {
    const file = path.join(dir, '.opencode', 'plugins', 'belayd.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export const Mine = async () => ({})\n');
    expect(opencodeSetup.uninstall(opts(false))).toEqual([]);
    const plan = opencodeSetup.plan(opts(false));
    expect(plan.warnings.join(' ')).toMatch(/not belayd's/);
    const backup = plan.apply();
    expect(fs.readFileSync(backup!, 'utf8')).toContain('Mine');
  });

  it('warns about an OpenCode too old for the plugin, and a plugin OpenCode 2 would skip', () => {
    fs.writeFileSync(path.join(dir, 'bin.js'), '');
    opencodeSetup.plan(opts(false)).apply();
    const old = { ...opts(false), env: { ...opts(false).env, BELAYD_OPENCODE_VERSION: '1.18.3' } };
    expect(opencodeSetup.doctor(old).some((l) => /older than 1\.18\.29/.test(l.text))).toBe(true);
    const fine = { ...opts(false), env: { ...opts(false).env, BELAYD_OPENCODE_VERSION: '2.1.1' } };
    expect(opencodeSetup.doctor(fine).some((l) => /older than/.test(l.text))).toBe(false);
    expect(opencodeSetup.doctor(fine).find((l) => l.status === 'note')?.text).toMatch(
      /type yourself with ! in OpenCode/,
    );
    const file = opencodeTarget({ workspace: opts(false).workspace, env: opts(false).env }).file;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('async server(', 'async old('));
    expect(opencodeSetup.doctor(fine).some((l) => /OpenCode 2 does not run it/.test(l.text))).toBe(
      true,
    );
  });

  it('reports a plugin whose paths no longer exist', () => {
    opencodeSetup.plan(opts(false)).apply();
    expect(opencodeSetup.doctor(opts(false))[0]).toMatchObject({ status: 'fail' });
  });

  it('exports one default and nothing else: OpenCode 1 rejects any export that is not a function', () => {
    const exports = [
      ...pluginSource({ nodePath: '/n', binPath: '/b' }).matchAll(/^export (\w+)/gm),
    ];
    expect(exports.map((m) => m[1])).toEqual(['default']);
  });

  describe('the plugin as OpenCode 1 and OpenCode 2 load it', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-ocplugin-'));
      // A stand-in belayd that says no to everything.
      fs.writeFileSync(
        path.join(dir, 'no.mjs'),
        "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ decision: 'deny', reason: 'nope' })));",
      );
      fs.writeFileSync(
        path.join(dir, 'belayd.mjs'),
        pluginSource({ nodePath: process.execPath, binPath: path.join(dir, 'no.mjs') }),
      );
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    const load = async () =>
      (await import(`${pathToFileURL(path.join(dir, 'belayd.mjs')).href}?${Math.random()}`)) as {
        default: Record<string, unknown>;
      };

    it('OpenCode 1: server() returns tool hooks that block on a no', async () => {
      const plugin = (await load()).default;
      expect(plugin.id).toBe('belayd');
      type Hook = (a: object, b: object) => Promise<void>;
      const server = plugin.server as (i: object) => Promise<Record<string, Hook>>;
      const hooks = await server({ directory: dir });
      await expect(
        hooks['tool.execute.before']!(
          { tool: 'bash', sessionID: 's', callID: 'c' },
          { args: { command: 'ls' } },
        ),
      ).rejects.toThrow('nope');
    });

    it('OpenCode 2: setup() hooks execute.before, which blocks on a no', async () => {
      // OpenCode 2 provides @opencode/plugin; this stand-in records what define() got.
      const pkg = path.join(dir, 'node_modules', '@opencode', 'plugin');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(
        path.join(pkg, 'package.json'),
        JSON.stringify({ name: '@opencode/plugin', type: 'module', exports: './index.js' }),
      );
      fs.writeFileSync(
        path.join(pkg, 'index.js'),
        'export const Plugin = { define: (d) => ({ ...d, defined: true }) };',
      );
      const plugin = (await load()).default as {
        defined?: boolean;
        setup: (ctx: object) => Promise<void>;
      };
      expect(plugin.defined).toBe(true);
      const hooks = new Map<string, (e: object) => Promise<void>>();
      await plugin.setup({
        location: { directory: dir },
        tool: {
          hook: async (name: string, fn: (e: object) => Promise<void>) => void hooks.set(name, fn),
        },
      });
      expect([...hooks.keys()]).toEqual(['execute.before', 'execute.after']);
      await expect(
        hooks.get('execute.before')!({
          tool: 'shell',
          sessionID: 's',
          id: 'c',
          input: { command: 'ls' },
        }),
      ).rejects.toThrow('nope');
    });
  });
});
