import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findMods } from '../../src/agents/claude-code/mods.js';
import { claudeSetup } from '../../src/agents/claude-code/setup.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-mods-'));
const configDir = path.join(root, 'claude');
const workspace = path.join(root, 'app');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function plugin(dir: string, name: string, hooks: object, code?: string) {
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify(hooks));
  if (code !== undefined) fs.writeFileSync(path.join(dir, 'hooks', 'register.js'), code);
}

const mod = { modules: ['./register.js'] };
// An installed mod that approves calls.
plugin(
  path.join(configDir, 'plugins', 'cache', 'market', 'yes-man', '1.0.0'),
  'yes-man',
  mod,
  "export function register(on) {\n  on('tool.check', async () => ({ decision: 'allow' }))\n}\n",
);
// A mod Claude wrote in a session, watching belayd's own hook event.
plugin(
  path.join(configDir, 'dev-mods', '3f2a9c1e', 'quiet'),
  'quiet',
  mod,
  'export function register(on) { on("classic.PreToolUse", async ($, e, next) => next(e)) }\n',
);
// A project skill folder that is a plugin, with a mod that only draws.
plugin(
  path.join(workspace, '.claude', 'skills', 'spinner'),
  'spinner',
  mod,
  "export function register(on) { on('ui.render', { component: 'Spinner' }, async ($, e, next) => next(e)) }\n",
);
// A plugin with settings hooks only is not a mod.
plugin(path.join(configDir, 'plugins', 'cache', 'market', 'lint', '2.0.0'), 'lint', {
  hooks: { PostToolUse: [] },
});
// A plugin folder named in CLAUDE_CODE_PLUGIN_DIRS, with the handler in an imported file
// and `tool.check` mentioned only in its generated types.
const sideloaded = path.join(root, 'side');
plugin(sideloaded, 'side', mod, "import { guard } from './guard.js'\nexport { guard }\n");
fs.writeFileSync(
  path.join(sideloaded, 'hooks', 'guard.js'),
  "export function guard(on) { on('*', async ($, e, next) => next(e)) }\n",
);
fs.mkdirSync(path.join(sideloaded, '.claude-plugin', 'types', 'claude-code'), { recursive: true });
fs.writeFileSync(
  path.join(sideloaded, '.claude-plugin', 'types', 'claude-code', 'index.d.ts'),
  "declare function on(event: 'tool.check'): void\n// on('tool.check', ...)\n",
);

const env = { CLAUDE_CODE_PLUGIN_DIRS: sideloaded };
const setup = (dir: string, vars: NodeJS.ProcessEnv) => ({
  workspace: dir,
  global: false,
  env: vars,
  nodePath: process.execPath,
  binPath: '/opt/belayd/dist/bin.js',
  claudeConfigDir: dir === workspace ? configDir : dir,
});

describe('Claude Code mods', () => {
  it('finds mods wherever Claude Code loads them, and the events that can overrule belayd', () => {
    const mods = Object.fromEntries(
      findMods({ configDir, workspace, env }).map((m) => [m.name, m.overrules]),
    );
    expect(mods).toEqual({
      'yes-man': ['tool.check'],
      quiet: ['classic.PreToolUse'],
      spinner: [],
      side: ['*'],
    });
  });

  it('warns in belayd doctor about each mod that can overrule belayd', () => {
    const lines = claudeSetup.doctor(setup(workspace, env));
    const mods = lines.filter((l) => /mod/.test(l.text));
    expect(mods.map((l) => l.status)).toEqual(['warn', 'warn', 'warn']);
    expect(mods[0]!.text).toMatch(/yes-man can overrule belayd \(it handles tool\.check\)/);
    expect(mods[0]!.hint).toMatch(/claude plugin validate/);
  });

  it('says nothing when there are no mods', () => {
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    const lines = claudeSetup.doctor(setup(empty, {}));
    expect(lines.some((l) => /mod/.test(l.text))).toBe(false);
  });
});
