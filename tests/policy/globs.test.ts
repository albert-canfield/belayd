import { describe, expect, it } from 'vitest';
import { evaluate } from '../../src/policy/engine.js';
import { loadPolicy } from '../../src/policy/load.js';
import type { ActionContext } from '../../src/policy/types.js';

const ctx: ActionContext = {
  agent: 'claude-code',
  cwd: '/work/app',
  workspace: '/work/app',
  home: '/home/dev',
};
const grep = async (glob: string) =>
  evaluate(
    { kind: 'read', path: '/work/app', glob },
    ctx,
    await loadPolicy({ workspace: '/work/app', belaydHome: '/tmp/none', noCache: true }),
    { belaydHome: '/tmp/none' },
  ).verdict;

describe('globs given to the Grep and Glob tools', () => {
  it('match dotfiles the way ripgrep does', async () => {
    expect(await grep('*.env')).toBe('deny');
    expect(await grep('.env*')).toBe('deny');
    expect(await grep('**/*.env')).toBe('deny');
  });

  it('leave ordinary globs alone', async () => {
    expect(await grep('*.ts')).toBe('pass');
    expect(await grep('**/*.{ts,tsx}')).toBe('pass');
    expect(await grep('*')).toBe('pass');
  });
});
