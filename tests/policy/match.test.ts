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
