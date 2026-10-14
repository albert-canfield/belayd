import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENTS, findAgent, hookAgents } from '../../src/agents/registry.js';
import type { Dialect } from '../../src/agents/types.js';
import { handleToolHook } from '../../src/hook/handle.js';

/**
 * Every agent belayd hooks into must behave the same way where it matters. A new
 * adapter only has to describe its payloads (Dialect.sample) and read its own answers
 * back (Dialect.verdictOf) to be held to all of this.
 */

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-conformance-')));
  fs.mkdirSync(path.join(dir, '.git'));
  env = { HOME: path.join(dir, 'home'), BELAYD_HOME: path.join(dir, 'belayd-home') };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (dialect: Dialect, raw: string, timeoutSec = 30, event = 'pre') =>
  handleToolHook(raw, { env, timeoutSec, event }, dialect);
const pre = (dialect: Dialect, command: string) =>
  JSON.stringify(dialect.sample('pre', command, dir));

describe.each(hookAgents().map((a) => [a.name, a] as const))('%s', (_name, agent) => {
  let dialect: Dialect;
  beforeEach(async () => {
    dialect = await agent.dialect!();
  });

  it('blocks deleting the home folder', async () => {
    expect(dialect.verdictOf(await run(dialect, pre(dialect, 'rm -rf ~')))).toBe('deny');
  });

  it('blocks the same thing hidden behind a variable', async () => {
    const r = await run(dialect, pre(dialect, 'X=rm; bash -c "$X -rf ~"'));
    expect(dialect.verdictOf(r)).toBe('deny');
  });

  it('stays quiet for normal work', async () => {
    expect(dialect.verdictOf(await run(dialect, pre(dialect, 'npm test')))).toBe('pass');
  });

  it('blocks when it cannot read the input', async () => {
    expect(dialect.verdictOf(await run(dialect, 'not json'))).toBe('deny');
    expect(dialect.verdictOf(await run(dialect, '[1, 2]'))).toBe('deny');
  });

  it('never lets a question through unanswered', async () => {
    // Either the agent shows its own prompt (ask), or belayd holds the call and nobody
    // answers within the deadline (deny). Never a silent pass or allow.
    const r = await run(dialect, pre(dialect, 'sudo ls'), 7);
    expect(['ask', 'deny']).toContain(dialect.verdictOf(r));
  });

  it('records what ran after the tool call', async () => {
    expect(dialect.parse(dialect.sample('post', 'npm test', dir), 'post').phase).toBe('post');
    const r = await run(
      dialect,
      JSON.stringify(dialect.sample('post', 'npm test', dir)),
      30,
      'post',
    );
    expect(r.exitCode).toBe(0);
    expect(dialect.verdictOf(r)).toBe('pass');
    expect(fs.existsSync(path.join(env.BELAYD_HOME!, 'audit.db'))).toBe(true);
  });

  it('reads the tool call it was given', () => {
    const event = dialect.parse(dialect.sample('pre', 'echo hi', dir), 'pre');
    expect(event.phase).toBe('pre');
    expect(dialect.toAction(event.tool, event.input, dir)).toEqual({
      kind: 'shell',
      command: 'echo hi',
    });
    expect(dialect.agent(dialect.sample('pre', 'echo hi', dir), env)).toBe(agent.id);
  });
});

describe('the agent registry', () => {
  it('has a dialect and a setup for every agent belayd hooks into', () => {
    for (const agent of hookAgents()) {
      expect(agent.dialect, agent.id).toBeTypeOf('function');
      expect(agent.setup, agent.id).toBeTypeOf('function');
    }
  });

  it('points every host at an agent belayd hooks into', () => {
    for (const host of AGENTS.filter((a) => a.support === 'host'))
      expect(findAgent(host.runsHooksOf!)?.support, host.id).toBe('hooks');
  });

  it('points every launcher at agents belayd hooks into, and says what it misses', () => {
    for (const launcher of AGENTS.filter((a) => a.support === 'launcher')) {
      expect(launcher.launches?.length, launcher.id).toBeGreaterThan(0);
      for (const id of launcher.launches!) expect(findAgent(id)?.support, id).toBe('hooks');
      expect(launcher.gap, launcher.id).toBeTruthy();
    }
  });

  it('finds agents by id and alias, case-insensitively', () => {
    expect(findAgent('Claude')?.id).toBe('claude-code');
    expect(findAgent('codex')?.id).toBe('codex');
    expect(findAgent('nope')).toBeUndefined();
  });

  it('uses each name once', () => {
    const names = AGENTS.flatMap((a) => [a.id, ...a.aliases]);
    expect(new Set(names).size).toBe(names.length);
  });
});
