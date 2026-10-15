import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { belayd, sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  sb.env.XDG_CONFIG_HOME = path.join(sb.dir, 'xdg');
});
afterEach(() => sb.cleanup());

type Hooks = Record<string, (input: object, output: object) => Promise<void>>;

/** Loads the installed plugin the way OpenCode does and returns its hooks. */
async function loadPlugin(file: string): Promise<Hooks> {
  // The plugin starts belayd as a child process, so give it the sandbox's environment.
  const saved = { ...process.env };
  Object.assign(process.env, sb.env);
  try {
    const mod = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as {
      Belayd: (ctx: { directory: string }) => Promise<Hooks>;
    };
    return await mod.Belayd({ directory: sb.project });
  } finally {
    process.env = saved;
  }
}

async function withSandboxEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  Object.assign(process.env, sb.env);
  try {
    return await fn();
  } finally {
    process.env = saved;
  }
}

describe('belayd for OpenCode (built binary, plugin loaded as OpenCode loads it)', () => {
  it('blocks a secret read, lets a harmless command run, and records both', async () => {
    const r = belayd(sb, ['init', '--agent', 'opencode', '--yes']);
    expect(r.status, r.stderr).toBe(0);
    const file = path.join(sb.project, '.opencode', 'plugins', 'belayd.js');
    expect(fs.existsSync(file)).toBe(true);
    const hooks = await loadPlugin(file);
    const before = hooks['tool.execute.before']!;
    const after = hooks['tool.execute.after']!;

    await withSandboxEnv(async () => {
      await expect(
        before({ tool: 'bash', sessionID: 's1', callID: 'c1' }, { args: { command: 'cat .env' } }),
      ).rejects.toThrow(/secrets/);
      await before({ tool: 'bash', sessionID: 's1', callID: 'c2' }, { args: { command: 'ls' } });
      await after(
        { tool: 'bash', sessionID: 's1', callID: 'c2', args: { command: 'ls' } },
        { title: '', output: '', metadata: {} },
      );
    });

    expect(belayd(sb, ['log']).stdout).toMatch(/cat \.env/);
    expect(belayd(sb, ['sessions']).stdout).toMatch(/OpenCode/);
  });

  it('blocks when belayd cannot run, instead of letting the call through', async () => {
    belayd(sb, ['init', '--agent', 'opencode', '--yes']);
    const file = path.join(sb.project, '.opencode', 'plugins', 'belayd.js');
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace(/const BIN = "[^"]*";/, 'const BIN = "/nonexistent/bin.js";'),
    );
    const hooks = await loadPlugin(file);
    await withSandboxEnv(() =>
      expect(
        hooks['tool.execute.before']!(
          { tool: 'bash', sessionID: 's', callID: 'c' },
          { args: { command: 'ls' } },
        ),
      ).rejects.toThrow(/belayd is not working/),
    );
  });

  it('is removed by uninstall', () => {
    belayd(sb, ['init', '--agent', 'opencode', '--yes']);
    expect(belayd(sb, ['uninstall', '--yes']).status).toBe(0);
    expect(fs.existsSync(path.join(sb.project, '.opencode', 'plugins', 'belayd.js'))).toBe(false);
  });
});
