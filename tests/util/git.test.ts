import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { excludeFromGit } from '../../src/agents/common.js';
import { committedUnchanged } from '../../src/policy/subjects.js';
import { untrustedGit } from '../../src/util/git.js';

/**
 * A repository can carry its own `.git/config` (an unpacked archive, or one an agent
 * edited). Its fsmonitor command, filter drivers and hooks must never run because belayd
 * looked at the repository.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-git-'));
const repo = path.join(root, 'repo');
const canaries = path.join(root, 'canaries');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });

fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(canaries);
git('init', '-q');
fs.writeFileSync(path.join(repo, 'run.sh'), 'echo hi\n');
fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=evil\n');
git('add', '.');
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
const touch = (name: string) => `touch '${path.join(canaries, name)}'`;
git('config', 'core.fsmonitor', `${touch('fsmonitor')}; false`);
git('config', 'filter.evil.clean', `${touch('filter')}; cat`);
git('config', 'filter.evil.process', touch('process'));
const hooks = path.join(repo, '.git', 'hooks');
for (const hook of ['post-index-change', 'post-checkout', 'pre-commit']) {
  fs.writeFileSync(path.join(hooks, hook), `#!/bin/sh\n${touch(hook)}\n`, { mode: 0o755 });
}

/** Makes the file's stat data look changed, so git compares contents (through filters). */
const stale = () => {
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(repo, 'run.sh'), t, t);
};

describe('git in a repository belayd does not own', () => {
  it('runs no fsmonitor command, filter or hook', () => {
    stale();
    untrustedGit(['status', '--porcelain=v1', '--', 'run.sh'], { cwd: repo });
    stale();
    expect(committedUnchanged(path.join(repo, 'run.sh'))).toBe(true);
    expect(excludeFromGit(repo, path.join(repo, 'belayd-test-local.json'))).toBe(true);
    expect(fs.readdirSync(canaries)).toEqual([]);
  });

  it('ignores GIT_ variables that point elsewhere', () => {
    const before = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(root, 'nowhere');
    try {
      expect(untrustedGit(['rev-parse', '--is-inside-work-tree'], { cwd: repo }).trim()).toBe(
        'true',
      );
    } finally {
      if (before === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = before;
    }
  });
});
