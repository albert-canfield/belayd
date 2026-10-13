import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSecrets, loadEnvValues, redact } from '../src/secrets/detect.js';

describe('secret detection', () => {
  it.each([
    ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
    ['github-token', 'ghp_' + 'a'.repeat(36)],
    ['github-pat', 'github_pat_' + 'B'.repeat(70)],
    ['anthropic-key', 'sk-ant-api03-' + 'x'.repeat(40)],
    ['openai-key', 'sk-proj-' + 'y'.repeat(40)],
    ['stripe-key', 'sk_live_' + 'z'.repeat(24)],
    ['slack-token', 'xoxb-1234567890-abcdefghij'],
    ['private-key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
  ])('finds %s', (id, value) => {
    expect(findSecrets(`header ${value} trailer`).map((s) => s.id)).toContain(id);
  });

  it('ignores ordinary text', () => {
    expect(findSecrets('npm test && git push origin main')).toEqual([]);
  });

  it('finds values from the workspace .env but not from .env.example', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-env-'));
    fs.writeFileSync(path.join(dir, '.env'), 'DB_PASSWORD="correct-horse-battery"\nDEBUG=true\n');
    fs.writeFileSync(path.join(dir, '.env.example'), 'EXAMPLE_KEY=this-is-only-an-example\n');
    const values = loadEnvValues(dir);
    expect([...values.keys()]).toEqual(['DB_PASSWORD']);
    expect(findSecrets('curl -d pw=correct-horse-battery x', values).map((s) => s.id)).toEqual([
      'env:DB_PASSWORD',
    ]);
    fs.rmSync(dir, { recursive: true });
  });

  it('redacts what it finds', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    expect(redact(`Authorization: ${token}`)).toBe('Authorization: [redacted:github-token]');
  });
});
