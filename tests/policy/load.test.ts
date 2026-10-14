import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluate } from '../../src/policy/engine.js';
import { loadPolicy, PolicyError } from '../../src/policy/load.js';
import type { ActionContext } from '../../src/policy/types.js';

let dir: string;
let home: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-load-'));
  home = path.join(dir, '.belayd');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (text: string) => fs.writeFileSync(path.join(dir, 'belayd.yaml'), text);
const load = () => loadPolicy({ workspace: dir, belaydHome: home });
const ctx = (): ActionContext => ({ agent: 'cli', cwd: dir, workspace: dir, home: '/home/dev' });
const verdict = async (command: string) =>
  evaluate({ kind: 'shell', command }, ctx(), await load(), { belaydHome: home }).verdict;

describe('policy loading', () => {
  it('falls back to the balanced preset without a policy file', async () => {
    expect((await load()).preset).toBe('balanced');
  });

  it('lets user rules override preset rules', async () => {
    write(`version: 1
rules:
  - id: allow-force-push-to-forks
    match: { command: git push, args: { any: [fork] } }
    decision: allow
`);
    expect(await verdict('git push --force fork main')).toBe('allow');
    expect(await verdict('git push --force origin main')).toBe('deny');
  });

  it('never lets a user rule lower a final rule', async () => {
    write(`version: 1
rules:
  - id: yolo
    match: { command: rm }
    decision: allow
`);
    expect(await verdict('rm -rf ~')).toBe('deny');
    expect(await verdict('rm -rf build')).toBe('allow');
  });

  it('can disable a final rule explicitly', async () => {
    write(`version: 1
disable: [no-delete-system-or-home]
`);
    expect(await verdict('rm -rf ~')).not.toBe('deny');
  });

  it('rejects unknown keys with a useful message', async () => {
    write(`version: 1
rules:
  - id: typo
    match: { comand: rm }
    decision: deny
`);
    await expect(load()).rejects.toThrow(/comand/);
  });

  it('rejects disabling a rule that does not exist', async () => {
    write('version: 1\ndisable: [no-such-rule]\n');
    await expect(load()).rejects.toThrow(PolicyError);
  });

  it('rejects invalid YAML', async () => {
    write('version: 1\nrules: [\n');
    await expect(load()).rejects.toThrow(/YAML/);
  });

  it('caches the compiled policy and notices edits', async () => {
    write('version: 1\nextends: strict\n');
    expect((await load()).preset).toBe('strict');
    expect(fs.readdirSync(path.join(home, 'cache')).length).toBe(1);
    write('version: 1\nextends: yolo-with-undo\n');
    expect((await load()).preset).toBe('yolo-with-undo');
  });

  it('uses $BELAYD_HOME/belayd.yaml when the project has none', async () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'belayd.yaml'), 'version: 1\nextends: strict\n');
    expect((await load()).preset).toBe('strict');
  });
});

describe('example policies', () => {
  const dir = new URL('../../examples/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  it('exist', () => expect(files.length).toBeGreaterThan(2));
  for (const f of files) {
    it(`${f} is a valid policy`, async () => {
      const policy = await loadPolicy({
        workspace: '/work/app',
        belaydHome: '/tmp/none',
        policyPath: fileURLToPath(new URL(f, dir)),
        noCache: true,
      });
      expect(policy.rules.user.length).toBeGreaterThan(0);
    });
  }
});
