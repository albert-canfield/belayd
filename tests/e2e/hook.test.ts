import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { belayd, hookPayload, sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => (sb = sandbox()));
afterEach(() => sb.cleanup());

const hook = (input: string, env?: NodeJS.ProcessEnv) =>
  belayd(sb, ['hook', 'claude-code'], { input, ...(env ? { env } : {}) });
const decision = (stdout: string) =>
  stdout ? JSON.parse(stdout).hookSpecificOutput.permissionDecision : 'pass';

describe('belayd hook claude-code (built binary)', () => {
  it('blocks rm -rf ~', () => {
    const r = hook(hookPayload(sb, 'Bash', { command: 'rm -rf ~' }));
    expect(r.status).toBe(0);
    expect(decision(r.stdout)).toBe('deny');
  });

  it('blocks an obfuscated version too', () => {
    const r = hook(hookPayload(sb, 'Bash', { command: 'X=rm; bash -c "$X -rf ~"' }));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('stays silent for normal work', () => {
    const r = hook(hookPayload(sb, 'Bash', { command: 'npm test' }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('writes a policy cache and gives the same answer from it', () => {
    const payload = hookPayload(sb, 'Bash', { command: 'git push -f' });
    expect(decision(hook(payload).stdout)).toBe('deny');
    expect(fs.readdirSync(path.join(sb.env.BELAYD_HOME!, 'cache')).length).toBe(1);
    expect(decision(hook(payload).stdout)).toBe('deny');
  });

  it('fails closed when the policy file is broken', () => {
    fs.writeFileSync(path.join(sb.project, 'belayd.yaml'), 'version: 2\n');
    const r = hook(hookPayload(sb, 'Bash', { command: 'ls' }));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('fails closed on garbage input', () => {
    expect(decision(hook('{{{').stdout)).toBe('deny');
  });

  it('exits 2 for an unknown agent, which blocks in every Claude-style agent', () => {
    const r = belayd(sb, ['hook', 'nope'], { input: '{}' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/blocking this action/);
  });

  it('still works when BELAYD_HOME cannot be written', () => {
    const r = hook(hookPayload(sb, 'Bash', { command: 'rm -rf ~' }), {
      BELAYD_HOME: '/dev/null/nope',
    });
    expect(decision(r.stdout)).toBe('deny');
  });
});
