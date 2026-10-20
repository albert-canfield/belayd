import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Shadow } from '../../src/snapshots/shadow.js';

let dir: string;
let ws: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-shadow-')));
  ws = path.join(dir, 'project');
  fs.mkdirSync(ws, { recursive: true });
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const put = (rel: string, content: string | Buffer, mode?: number) => {
  const file = path.join(ws, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode !== undefined ? { mode } : {});
};

/** Moves the clock on, so files written just now no longer count as written "just now". */
const later = (ms = 5000) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + ms);
};

const git = (gitDir: string, args: string[]) =>
  execFileSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8' });

describe('files too big to snapshot', () => {
  it('are reported once, and again only when they change', () => {
    put('big.dat', Buffer.alloc(4096, 1));
    put('a.txt', 'one\n');
    const shadow = new Shadow(path.join(dir, 'bh'), ws, { maxFileSize: 1024 });
    const first = shadow.snapshotAll();
    expect(first.skipped).toEqual(['big.dat']);
    expect(first.changed?.sort()).toEqual(['a.txt', 'big.dat']);

    later();
    // Written a moment ago, so it was not trusted yet; now it is old enough to remember.
    expect(shadow.snapshotAll().changed).toEqual(['big.dat']);
    const quiet = shadow.snapshotAll();
    expect(quiet.changed).toBeUndefined();
    expect(quiet.skipped).toBeUndefined();

    put('a.txt', 'two\n');
    expect(shadow.snapshotAll().changed).toEqual(['a.txt']);

    fs.appendFileSync(path.join(ws, 'big.dat'), 'more');
    const grown = shadow.snapshotAll();
    expect(grown.changed).toEqual(['big.dat']);
    expect(grown.skipped).toEqual(['big.dat']);
    expect(shadow.blobAt(grown.tree, 'big.dat')).toBeUndefined();
  });

  it('are captured once they fit, and forgotten once deleted', () => {
    put('big.dat', Buffer.alloc(4096, 1));
    const shadow = new Shadow(path.join(dir, 'bh'), ws, { maxFileSize: 1024 });
    shadow.snapshotAll();
    later();
    shadow.snapshotAll();
    put('big.dat', 'small now\n');
    const fits = shadow.snapshotAll();
    expect(fits.changed).toEqual(['big.dat']);
    expect(shadow.blobAt(fits.tree, 'big.dat')).toBeDefined();

    put('other.dat', Buffer.alloc(4096, 2));
    shadow.snapshotAll();
    later(10_000);
    shadow.snapshotAll();
    fs.rmSync(path.join(ws, 'other.dat'));
    expect(shadow.snapshotAll().changed).toBeUndefined();
    expect(fs.existsSync(path.join(shadow.dir, 'belayd-too-big-files.json'))).toBe(false);
  });
});

describe('many files at once', () => {
  /** A project with nested folders, a link, a script, a nested repository and a big file. */
  function project(): void {
    for (let i = 0; i < 160; i++) put(`src/m${i % 7}/f${i}.ts`, `export const v = ${i};\n`);
    put('run.sh', '#!/bin/sh\n', 0o755);
    fs.symlinkSync('run.sh', path.join(ws, 'link'));
    put('big.dat', Buffer.alloc(4096, 1));
    const nested = path.join(ws, 'vendor', 'lib');
    fs.mkdirSync(nested, { recursive: true });
    const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
    execFileSync('git', ['init', '-q'], { cwd: nested, env });
    fs.writeFileSync(path.join(nested, 'x.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: nested, env });
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x', '--no-gpg-sign'],
      { cwd: nested, env },
    );
  }

  it('store exactly what a few at a time would, in one pack', () => {
    project();
    const bulk = new Shadow(path.join(dir, 'bulk'), ws, { maxFileSize: 1024 });
    const all = bulk.snapshotAll();
    expect(all.skipped).toEqual(['big.dat']);
    const packs = fs.readdirSync(path.join(bulk.dir, 'objects', 'pack'));
    expect(packs.some((f) => f.endsWith('.pack'))).toBe(true);

    // The same files, captured a few at a time, give the same tree.
    const paths = (all.changed ?? []).filter((p) => p !== 'big.dat');
    const step = new Shadow(path.join(dir, 'step'), ws, { maxFileSize: 1024 });
    let tree = '';
    for (let i = 0; i < paths.length; i += 40)
      tree = step.snapshotPaths(paths.slice(i, i + 40)).tree;
    expect(tree).toBe(all.tree);
    expect(git(bulk.dir, ['ls-tree', all.tree, 'run.sh'])).toMatch(/^100755 /);
    expect(git(bulk.dir, ['ls-tree', all.tree, 'link'])).toMatch(/^120000 /);
    expect(git(bulk.dir, ['ls-tree', all.tree, 'vendor/lib'])).toMatch(/^160000 commit /);
  });

  it('record deletions and a link where a folder was', () => {
    project();
    const shadow = new Shadow(path.join(dir, 'bh'), ws, { maxFileSize: 1024 });
    shadow.snapshotAll();
    fs.rmSync(path.join(ws, 'src', 'm1'), { recursive: true });
    fs.rmSync(path.join(ws, 'src', 'm2'), { recursive: true });
    fs.symlinkSync('m3', path.join(ws, 'src', 'm2'));
    for (let i = 0; i < 120; i++) put(`gen/g${i}.ts`, `${i}\n`);
    const after = shadow.snapshotAll();
    expect(after.changed?.length).toBeGreaterThanOrEqual(100);
    expect(shadow.blobAt(after.tree, 'src/m1/f1.ts')).toBeUndefined();
    expect(git(shadow.dir, ['ls-tree', after.tree, 'src/m2'])).toMatch(/^120000 /);
    expect(shadow.blobAt(after.tree, 'gen/g7.ts')).toBeDefined();
    // Only the big file, written moments ago, is listed again.
    expect(shadow.snapshotAll().changed).toEqual(['big.dat']);
  });
});

it('moves HEAD along in a big project, so status does not list every file each time', () => {
  for (let i = 0; i < 1100; i++) put(`d${i % 30}/f${i}.txt`, `${i}\n`);
  const shadow = new Shadow(path.join(dir, 'bh'), ws);
  const first = shadow.snapshotAll();
  expect(git(shadow.dir, ['rev-parse', 'HEAD^{tree}']).trim()).toBe(first.tree);
  put('d1/f1.txt', 'changed\n');
  const second = shadow.snapshotAll();
  expect(second.changed).toEqual(['d1/f1.txt']);
  // A handful of changes do not move it again.
  expect(git(shadow.dir, ['rev-parse', 'HEAD^{tree}']).trim()).toBe(first.tree);
  expect(shadow.snapshotAll().changed).toBeUndefined();

  // A small project never needs it.
  const small = path.join(dir, 'small');
  fs.mkdirSync(small);
  fs.writeFileSync(path.join(small, 'a.txt'), 'a\n');
  const other = new Shadow(path.join(dir, 'bh2'), small);
  other.snapshotAll();
  expect(() => git(other.dir, ['rev-parse', '--verify', '-q', 'HEAD'])).toThrow();
});

it('keeps what status learns, so a touched file is not read again on every snapshot', () => {
  for (let i = 0; i < 20; i++) put(`d${i}/f.txt`, `${i}\n`);
  const shadow = new Shadow(path.join(dir, 'bh'), ws);
  shadow.snapshotAll();
  const index = () => fs.readFileSync(path.join(shadow.dir, 'index'));
  const before = index();
  // Same content, new file time (a checkout, a formatter that changed nothing).
  const t = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(ws, 'd3', 'f.txt'), t, t);
  expect(shadow.snapshotAll().changed).toBeUndefined();
  // Status found the file unchanged and saved its new stat data in our index.
  expect(index().equals(before)).toBe(false);
});

describe('a Git repository inside the project', () => {
  it('without a commit yet, does not stop snapshots of the rest', () => {
    put('a.txt', 'one\n');
    execFileSync('git', ['init', '-q', path.join(ws, 'fresh')]);
    put('fresh/notes.md', 'draft\n');
    const shadow = new Shadow(path.join(dir, 'bh'), ws);
    expect(() => shadow.snapshotAll()).not.toThrow();
    put('a.txt', 'two\n');
    const next = shadow.snapshotAll();
    expect(next.changed).toContain('a.txt');
  });
});
