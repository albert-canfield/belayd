import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { version } from '../src/version.js';

/**
 * Every release brings the docs in line with the code. These checks fail a version bump,
 * a new command or a new source folder until the changelog, the README, the plan and the
 * contributing guide have caught up.
 */
const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const readme = read('README.md');
const plan = read('docs/plan.md');
const contributing = read('CONTRIBUTING.md');

const minor = (v: string) => v.split('.').slice(0, 2).map(Number) as [number, number];
const newer = (a: string, b: string) => {
  const [a1, a2] = minor(a);
  const [b1, b2] = minor(b);
  return a1 > b1 || (a1 === b1 && a2 > b2);
};

describe('docs match the current version', () => {
  it('the changelog has a dated section for it', () => {
    expect(read('CHANGELOG.md')).toMatch(
      new RegExp(`^## ${version} \\(\\d{4}-\\d{2}-\\d{2}\\)$`, 'm'),
    );
  });

  it('the README pins the action to it', () => {
    const pins = [...readme.matchAll(/albert-canfield\/belayd@v([\d.]+)/g)].map((m) => m[1]);
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) expect(pin).toBe(version);
  });

  it('the plan lists it among the releases', () => {
    expect(plan).toContain(`| ${version} |`);
  });

  it("the README's plans name a version still to come", () => {
    const next = readme.match(/Planned for (\d+\.\d+)/)?.[1];
    expect(next, 'the "What\'s next" section names no version').toBeDefined();
    expect(newer(next!, version), `"Planned for ${next}" but ${version} is out`).toBe(true);
  });

  it("the plan's roadmap names a version still to come", () => {
    const next = plan.match(/^### (\d+\.\d+): /m)?.[1];
    expect(next, 'the plan has no "### X.Y: ..." roadmap section').toBeDefined();
    expect(newer(next!, version), `roadmap for ${next} but ${version} is out`).toBe(true);
  });
});

describe('docs cover what the code has', () => {
  it('the README commands table lists every command', () => {
    const table = readme.split('## Commands')[1]?.split('\n## ')[0] ?? '';
    const commands = [...read('src/cli/index.ts').matchAll(/\.command\('([a-z-]+)/g)].map(
      (m) => m[1]!,
    );
    expect(commands.length).toBeGreaterThan(10);
    for (const c of commands) expect(table, `belayd ${c}`).toContain(`\`belayd ${c}`);
  });

  it("CONTRIBUTING's map lists every source folder", () => {
    const folders = fs
      .readdirSync(new URL('../src', import.meta.url), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const f of folders) expect(contributing, `src/${f}/`).toContain(`src/${f}/`);
  });
});
