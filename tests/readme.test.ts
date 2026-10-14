import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENTS } from '../src/agents/registry.js';
import { evaluate } from '../src/policy/engine.js';
import { loadPolicy } from '../src/policy/load.js';
import type { ActionContext, Verdict } from '../src/policy/types.js';

/**
 * The README promises what belayd catches. This test keeps that table honest:
 * every row is evaluated against the balanced preset.
 */
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const table = readme.split('<!-- catches:start -->')[1]?.split('<!-- catches:end -->')[0] ?? '';
const WORDS: Record<string, Verdict> = {
  blocked: 'deny',
  asks: 'ask',
  quiet: 'pass',
  allowed: 'allow',
};

const rows = table
  .split('\n')
  .filter((l) => l.startsWith('| `'))
  .map((l) => {
    const cells = l.split(/(?<!\\)\|/).map((c) => c.trim());
    return { command: cells[1]!.slice(1, -1).replace(/\\\|/g, '|'), word: cells[2]! };
  });

const ctx: ActionContext = {
  agent: 'cli',
  cwd: '/work/app',
  workspace: '/work/app',
  home: '/home/dev',
};
const policy = await loadPolicy({
  workspace: ctx.workspace,
  belaydHome: '/home/dev/.belayd',
  preset: 'balanced',
  noCache: true,
});

describe('README "What it catches" table', () => {
  it('has rows', () => expect(rows.length).toBeGreaterThan(10));
  for (const row of rows) {
    it(`${row.word}: ${row.command}`, () => {
      expect(WORDS[row.word], `unknown word "${row.word}"`).toBeDefined();
      const d = evaluate({ kind: 'shell', command: row.command }, ctx, policy, {
        belaydHome: '/home/dev/.belayd',
      });
      expect(d.verdict, d.reason).toBe(WORDS[row.word]);
    });
  }
});

describe('README agents table', () => {
  const agents = readme.split('<!-- agents:start -->')[1]?.split('<!-- agents:end -->')[0] ?? '';

  it('lists every agent belayd knows, as supported or planned', () => {
    for (const agent of AGENTS) {
      const row = agents.split('\n').find((l) => l.includes(agent.name));
      expect(row, agent.name).toBeDefined();
      if (agent.support === 'planned') expect(row, agent.name).toMatch(/Planned/);
      else expect(row, agent.name).not.toMatch(/Planned/);
    }
  });
});
