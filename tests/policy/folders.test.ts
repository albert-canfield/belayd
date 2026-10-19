import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeExtraFolders } from '../../src/agents/claude-code/hook.js';
import { evaluate } from '../../src/policy/engine.js';
import { loadPolicy } from '../../src/policy/load.js';
import { trustFile } from '../../src/policy/trust.js';

let dir: string;
let ws: string;
let home: string;
let bh: string;
// Outside os.tmpdir() checks need a home that is not the temp folder's parent: belayd
// treats the temp folder as scratch space, so the sibling lives under a fake home.
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-folders-')));
  home = path.join(dir, 'home');
  ws = path.join(home, 'code', 'app');
  bh = path.join(dir, 'bh');
  for (const d of [ws, path.join(home, 'code', 'app-shared'), path.join(home, 'code', 'other')])
    fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(ws, '.git'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const OUTSIDE =
  "rules:\n  - { id: outside, match: { writes: ['!{workspace}', '!{workspace}/**'] }, decision: ask }\n";

const verdict = async (file: string, extra: string[] = []) => {
  const policy = await loadPolicy({ workspace: ws, belaydHome: bh, noCache: true });
  return evaluate(
    { kind: 'write', path: file, content: 'x' },
    {
      agent: 'claude-code',
      cwd: ws,
      workspace: ws,
      home,
      ...(extra.length ? { folders: extra } : {}),
    },
    policy,
    { belaydHome: bh },
  ).verdict;
};

describe('folders in belayd.yaml', () => {
  it('counts the folders a trusted belayd.yaml names as part of the project', async () => {
    const file = path.join(ws, 'belayd.yaml');
    // A rule that asks about any write outside {workspace}, wherever the folders are.
    fs.writeFileSync(file, `version: 1\nfolders: [../app-shared]\n${OUTSIDE}`);
    trustFile(bh, file);
    expect(await verdict(path.join(home, 'code', 'app-shared', 'x.ts'))).toBe('pass');
    expect(await verdict(path.join(home, 'code', 'other', 'x.ts'))).toBe('ask');
  });

  it('ignores folders in a belayd.yaml you have not trusted', async () => {
    fs.writeFileSync(
      path.join(ws, 'belayd.yaml'),
      `version: 1\nfolders: [../app-shared]\n${OUTSIDE}`,
    );
    expect(await verdict(path.join(home, 'code', 'app-shared', 'x.ts'))).toBe('ask');
    const policy = await loadPolicy({ workspace: ws, belaydHome: bh, noCache: true });
    expect(policy.warnings.join(' ')).toContain('Ignored: folders');
  });

  it('never lets the home folder or the disk count as the project', async () => {
    const file = path.join(ws, 'belayd.yaml');
    fs.writeFileSync(file, `version: 1\nfolders: [/, '${os.homedir()}', '~']\n`);
    trustFile(bh, file);
    const policy = await loadPolicy({ workspace: ws, belaydHome: bh, noCache: true });
    expect(policy.folders).toEqual([]);
  });

  it('still protects agent settings inside an extra folder', async () => {
    const shared = path.join(home, 'code', 'app-shared');
    expect(await verdict(path.join(shared, '.claude', 'settings.json'), [shared])).toBe('ask');
    expect(await verdict(path.join(shared, 'src', 'x.ts'), [shared])).toBe('pass');
  });
});

describe("Claude Code's extra folders", () => {
  it('reads additionalDirectories from your own settings only, and drops broad ones', () => {
    const config = path.join(dir, 'claude');
    fs.mkdirSync(config);
    fs.writeFileSync(
      path.join(config, 'settings.json'),
      JSON.stringify({
        permissions: { additionalDirectories: ['/srv/shared', '/', home, '~/notes', 3] },
      }),
    );
    expect(claudeExtraFolders({ HOME: home, CLAUDE_CONFIG_DIR: config })).toEqual([
      '/srv/shared',
      path.join(home, 'notes'),
    ]);
    expect(claudeExtraFolders({ HOME: home, CLAUDE_CONFIG_DIR: path.join(dir, 'none') })).toEqual(
      [],
    );
  });
});
