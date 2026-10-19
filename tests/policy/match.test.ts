import { describe, expect, it } from 'vitest';
import { wildcard } from '../../src/policy/match.js';

describe('wildcard', () => {
  it('matches * and ? and nothing else specially', () => {
    expect(wildcard('npm *', 'npm test')).toBe(true);
    expect(wildcard('npm *', 'npx test')).toBe(false);
    expect(wildcard('git push*', 'git push')).toBe(true);
    expect(wildcard('a?c', 'abc')).toBe(true);
    expect(wildcard('a?c', 'ac')).toBe(false);
    expect(wildcard('*.example.com', 'API.Example.com', true)).toBe(true);
    expect(wildcard('[ab]', '[ab]')).toBe(true);
    expect(wildcard('a.c', 'abc')).toBe(false);
    expect(wildcard('*', '')).toBe(true);
    expect(wildcard('', 'x')).toBe(false);
    expect(wildcard('*a*b', 'xxaxxbxb')).toBe(true);
    expect(wildcard('line*', 'line one\nline two')).toBe(true);
  });

  it('stays fast on patterns that make a regex backtrack', () => {
    const started = Date.now();
    expect(wildcard(`${'*e'.repeat(22)}*Q`, 'e'.repeat(48) + 'x'.repeat(230))).toBe(false);
    expect(wildcard('*a'.repeat(200), 'a'.repeat(5000) + 'b')).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('anyOf (fast path matching)', () => {
  it('answers exactly like picomatch for every path pattern in the presets', async () => {
    const { anyOf, expandPlaceholders } = await import('../../src/policy/match.js');
    const picomatch = (await import('picomatch')).default;
    const { parse } = await import('yaml');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(__dirname, '..', '..', 'presets');
    const patterns = new Set<string>();
    const collect = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          if (['path', 'reads', 'writes', 'pathsOnly'].includes(k))
            (Array.isArray(x) ? x : [x]).forEach((p) => typeof p === 'string' && patterns.add(p));
          else collect(x);
        }
    };
    for (const f of fs.readdirSync(dir)) collect(parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    const vars = {
      workspace: ['/Users/al/SITES DEV/my app (v2)'],
      home: ['/Users/al'],
      tmp: ['/tmp', '/private/var/folders/x/T'],
      cwd: ['/Users/al/SITES DEV/my app (v2)/src'],
      belayd_home: ['/Users/al/.belayd'],
    };
    const expanded = [...patterns].flatMap((p) =>
      p.startsWith('!') ? [] : expandPlaceholders(p, vars),
    );
    expect(expanded.length).toBeGreaterThan(50);
    const nocase = process.platform === 'darwin' || process.platform === 'win32';
    // Paths near every pattern: the pattern without wildcards, inside it, beside it,
    // in other case, with dotfiles and trailing slashes.
    const paths = new Set<string>(['/', '/etc/hosts', '/Users/al/.ssh/id_rsa', '/Users/al/x']);
    for (const p of expanded) {
      const base = p
        .replace(/\\(.)/g, '$1')
        .replace(/\/\*\*$/, '')
        .replace(/[*?]/g, 'x');
      for (const q of [
        base,
        `${base}/`,
        `${base}/a`,
        `${base}/.env`,
        `${base}c`,
        base.toUpperCase(),
        `${base}/a/b.key`,
        path.dirname(base),
      ])
        paths.add(q);
    }
    for (const p of expanded) {
      const fast = anyOf([p]);
      const slow = picomatch([p], { dot: true, nocase });
      for (const q of paths) expect(fast(q), `${p} vs ${q}`).toBe(slow(q));
    }
    const all = anyOf(expanded);
    const slowAll = picomatch(expanded, { dot: true, nocase });
    for (const q of paths) expect(all(q), q).toBe(slowAll(q));
  });
});
