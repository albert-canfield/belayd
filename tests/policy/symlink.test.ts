import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluate } from '../../src/policy/engine.js';
import { loadPolicy } from '../../src/policy/load.js';
import type { ActionContext } from '../../src/policy/types.js';

let root: string;
let ctx: ActionContext;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-link-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'project');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'not a real key');
  fs.mkdirSync(workspace, { recursive: true });
  fs.symlinkSync(path.join(home, '.ssh'), path.join(workspace, 'keys'));
  fs.symlinkSync(path.join(home), path.join(workspace, 'up'));
  ctx = { agent: 'cli', cwd: workspace, workspace, home };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const verdict = async (action: Parameters<typeof evaluate>[0]) =>
  evaluate(
    action,
    ctx,
    await loadPolicy({
      workspace: ctx.workspace,
      belaydHome: path.join(root, 'b'),
      preset: 'balanced',
      noCache: true,
    }),
    {
      belaydHome: path.join(root, 'b'),
    },
  ).verdict;

describe('symlinks', () => {
  it('judges a symlink into ~/.ssh as ~/.ssh', async () => {
    expect(await verdict({ kind: 'shell', command: 'cat keys/id_rsa' })).toBe('deny');
    expect(await verdict({ kind: 'read', path: 'keys/id_rsa' })).toBe('deny');
  });

  it('sees through a symlink that leads out of the project to agent settings', async () => {
    // `up` points at the home folder, so this really writes ~/.claude/settings.json.
    expect(await verdict({ kind: 'write', path: 'up/.claude/settings.json' })).toBe('ask');
    expect(await verdict({ kind: 'shell', command: 'echo {} > up/.claude/settings.json' })).toBe(
      'ask',
    );
  });

  it('does not flag ordinary files inside the project', async () => {
    expect(await verdict({ kind: 'write', path: 'src/a.ts' })).toBe('pass');
  });
});
