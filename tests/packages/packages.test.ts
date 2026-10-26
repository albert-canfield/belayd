import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makePackageCheck, prefetchPackages } from '../../src/packages/check.js';
import { lookupPackages, type Fetcher } from '../../src/packages/registry.js';
import { npmName, pypiName, requestedPackages } from '../../src/packages/requests.js';
import { evaluate } from '../../src/policy/engine.js';
import { loadPolicy } from '../../src/policy/load.js';
import { buildSubjects } from '../../src/policy/subjects.js';
import type { ActionContext } from '../../src/policy/types.js';

let root: string;
let ws: string;
let home: string;
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-26T12:00:00Z');

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-pkg-')));
  ws = path.join(root, 'app');
  home = path.join(root, 'bh');
  fs.mkdirSync(ws);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const ctx = (): ActionContext => ({ agent: 'cli', cwd: ws, workspace: ws, home: root });
const env = (): NodeJS.ProcessEnv => ({ HOME: root });
const requests = (command: string) =>
  buildSubjects({ kind: 'shell', command }, ctx()).flatMap((s) => requestedPackages(s, ws, env()));

/** A registry that knows `old-pkg` (two years), `fresh-pkg` (three days) and `huge-pkg`. */
const registry = (): Fetcher & { calls: string[] } => {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const created = (ms: number) =>
      new Response(JSON.stringify({ time: { created: new Date(ms).toISOString() } }));
    if (url.endsWith('/old-pkg')) return created(NOW - 700 * DAY);
    if (url.endsWith('/fresh-pkg')) return created(NOW - 3 * DAY);
    if (url.endsWith('/huge-pkg')) return new Response('x'.repeat(2 * 1024 * 1024));
    if (url.includes('pypi.org/pypi/fresh-lib/'))
      return new Response(
        JSON.stringify({
          releases: { '0.1': [{ upload_time_iso_8601: new Date(NOW - 1 * DAY).toISOString() }] },
        }),
      );
    if (url.endsWith('/broken-pkg')) throw new Error('network down');
    return new Response('{}', { status: 404 });
  }) as unknown as Fetcher & { calls: string[] };
  f.calls = calls;
  return f;
};

describe('package names', () => {
  it('reads npm and PyPI specs, and leaves paths, URLs and git out', () => {
    expect(npmName('left-pad@^1.3.0')).toBe('left-pad');
    expect(npmName('@types/node@22')).toBe('@types/node');
    expect(npmName('./local')).toBeUndefined();
    expect(npmName('github:user/repo')).toBeUndefined();
    expect(npmName('user/repo')).toBeUndefined();
    expect(pypiName('Requests[socks]>=2.0')).toBe('requests');
    expect(pypiName('zope.interface==6')).toBe('zope-interface');
    expect(pypiName('./dist/pkg.whl')).toBeUndefined();
    expect(pypiName('git+https://x/y')).toBeUndefined();
  });
});

describe('what a command installs', () => {
  it.each([
    ['npm install fresh-pkg', 'npm:fresh-pkg'],
    ['npm i -D fresh-pkg@1', 'npm:fresh-pkg'],
    ['pnpm add fresh-pkg', 'npm:fresh-pkg'],
    ['yarn add fresh-pkg', 'npm:fresh-pkg'],
    ['bun add fresh-pkg', 'npm:fresh-pkg'],
    ['npx -y fresh-pkg --help', 'npm:fresh-pkg'],
    ['npx -p fresh-pkg run-it', 'npm:fresh-pkg'],
    ['pnpm dlx fresh-pkg', 'npm:fresh-pkg'],
    ['bash -c "npm install fresh-pkg"', 'npm:fresh-pkg'],
    ['pip install fresh-lib', 'pypi:fresh-lib'],
    ['python3 -m pip install --user fresh-lib', 'pypi:fresh-lib'],
    ['uv pip install fresh-lib', 'pypi:fresh-lib'],
    ['uv add fresh-lib', 'pypi:fresh-lib'],
    ['poetry add fresh-lib', 'pypi:fresh-lib'],
    ['uvx fresh-lib', 'pypi:fresh-lib'],
    ['pipx run fresh-lib', 'pypi:fresh-lib'],
  ])('%s', (command, key) => {
    expect(requests(command).map((r) => `${r.ecosystem}:${r.name}`)).toContain(key);
  });

  it('skips what the project already has, local commands, files and private indexes', () => {
    fs.writeFileSync(
      path.join(ws, 'package.json'),
      JSON.stringify({ devDependencies: { 'fresh-pkg': '1' } }),
    );
    fs.writeFileSync(path.join(ws, 'requirements.txt'), 'fresh-lib==0.1\n');
    expect(requests('npm install fresh-pkg')).toEqual([]);
    expect(requests('pip install fresh-lib')).toEqual([]);
    expect(requests('pip install -r requirements.txt')).toEqual([]);
    expect(requests('npm install')).toEqual([]);
    fs.mkdirSync(path.join(ws, 'node_modules/.bin'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'node_modules/.bin/mytool'), '');
    expect(requests('npx mytool')).toEqual([]);
    fs.writeFileSync(path.join(ws, '.npmrc'), 'registry=https://npm.internal.example/\n');
    expect(requests('npm install other-pkg')).toEqual([]);
    expect(
      buildSubjects({ kind: 'shell', command: 'pip install other-lib' }, ctx()).flatMap((s) =>
        requestedPackages(s, ws, { ...env(), PIP_INDEX_URL: 'https://pypi.internal.example' }),
      ),
    ).toEqual([]);
  });
});

describe('the registry lookup', () => {
  it('tells missing, new and established apart, and gives up quietly on errors', async () => {
    const f = registry();
    const facts = await lookupPackages(
      [
        { ecosystem: 'npm', name: 'old-pkg' },
        { ecosystem: 'npm', name: 'fresh-pkg' },
        { ecosystem: 'npm', name: 'huge-pkg' },
        { ecosystem: 'npm', name: 'made-up-pkg' },
        { ecosystem: 'npm', name: 'broken-pkg' },
        { ecosystem: 'pypi', name: 'fresh-lib' },
      ],
      home,
      f,
      NOW,
    );
    expect(facts.get('npm:old-pkg')?.created).toBe(NOW - 700 * DAY);
    expect(facts.get('npm:fresh-pkg')?.created).toBe(NOW - 3 * DAY);
    expect(facts.get('npm:huge-pkg')).toEqual({ established: true });
    expect(facts.get('npm:made-up-pkg')).toEqual({ missing: true });
    expect(facts.has('npm:broken-pkg')).toBe(false);
    expect(facts.get('pypi:fresh-lib')?.created).toBe(NOW - DAY);
  });

  it('asks the registry once a day per name', async () => {
    const f = registry();
    await lookupPackages([{ ecosystem: 'npm', name: 'old-pkg' }], home, f, NOW);
    await lookupPackages([{ ecosystem: 'npm', name: 'old-pkg' }], home, f, NOW + 1000);
    expect(f.calls).toHaveLength(1);
    await lookupPackages([{ ecosystem: 'npm', name: 'old-pkg' }], home, f, NOW + 2 * DAY);
    expect(f.calls).toHaveLength(2);
  });
});

describe('the rule', () => {
  const decide = async (command: string, policyText?: string) => {
    fs.mkdirSync(home, { recursive: true });
    if (policyText) fs.writeFileSync(path.join(home, 'belayd.yaml'), policyText);
    const policy = await loadPolicy({ workspace: ws, belaydHome: home, noCache: true });
    const action = { kind: 'shell' as const, command };
    const facts = await prefetchPackages(action, ctx(), {
      belaydHome: home,
      env: env(),
      fetcher: registry(),
    });
    return {
      policy,
      d: evaluate(action, ctx(), policy, {
        belaydHome: home,
        unknownPackage: makePackageCheck({ workspace: ws, env: env(), facts, now: NOW }),
      }),
    };
  };

  it('asks about a made-up or brand-new package, and not an established one', async () => {
    const made = (await decide('npm install made-up-pkg')).d;
    expect(made.ruleId).toBe('ask-unknown-package');
    expect(made.reason).toContain('npm has no package called made-up-pkg');
    expect((await decide('pip install fresh-lib')).d.reason).toContain(
      'fresh-lib first appeared on PyPI 1 day ago',
    );
    expect((await decide('npm install old-pkg')).d.verdict).toBe('pass');
    expect((await decide('npm install huge-pkg')).d.verdict).toBe('pass');
  });

  it('can be switched off in your own policy', async () => {
    const { policy } = await decide(
      'npm install old-pkg',
      'version: 1\npackages: { check: false }\n',
    );
    expect(policy.packages.check).toBe(false);
  });
});
