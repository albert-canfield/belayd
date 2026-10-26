import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fingerprint, kindName, SecretTally, TranscriptSecrets } from '../../src/scan/secrets.js';
import { SECRET_HINT } from '../../src/secrets/detect.js';

/** A made-up key that looks real, built at run time so no key-like text sits in the repo. */
function fake(
  prefix: string,
  n: number,
  seed: string,
  chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789',
): string {
  let out = '';
  for (let i = 0; out.length < n; i++)
    for (const b of createHash('sha256').update(`${seed}:${i}`).digest())
      if (out.length < n) out += chars[b % chars.length];
  return prefix + out;
}

const gh = fake('ghp_', 36, 'gh');
const aws = fake('AKIA', 16, 'aws', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
const finder = new TranscriptSecrets();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-scan-secrets-')));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('the line hint', () => {
  it.each([
    ['aws', aws],
    ['github', gh],
    ['github pat', fake('github_pat_', 70, 'pat')],
    ['gitlab', fake('glpat-', 24, 'gl')],
    ['slack', fake('xoxb-', 30, 'sl')],
    ['slack webhook', `https://hooks.slack.com/services/${fake('', 30, 'wh')}`],
    ['stripe', fake('sk_live_', 30, 'st')],
    ['anthropic', fake('sk-ant-api03-', 40, 'an')],
    ['openai', fake('sk-proj-', 40, 'oa')],
    ['google', fake('AIza', 35, 'go')],
    ['npm', fake('npm_', 36, 'np')],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['jwt', `eyJ${fake('', 20, 'j1')}.eyJ${fake('', 20, 'j2')}.${fake('', 20, 'j3')}`],
  ])('passes a %s that starts a line inside JSON, escaped once and twice', (_, value) => {
    const once = JSON.stringify({ text: `before\n${value}\nafter` });
    expect(SECRET_HINT.test(once)).toBe(true);
    expect(SECRET_HINT.test(JSON.stringify({ arguments: once }))).toBe(true);
  });

  it('lets ordinary lines through unparsed', () => {
    const line = JSON.stringify({ type: 'user', message: { content: 'npm test && git push' } });
    expect(finder.mayHold(line, '')).toBe(false);
  });
});

describe('finding secrets in an entry', () => {
  const claude = (type: string, content: unknown, extra: object = {}) => ({
    type,
    message: { role: type, content },
    ...extra,
  });
  const places = (entry: unknown) =>
    finder.find(entry, '').map((f) => [f.place, f.kinds.join(), f.fingerprint]);

  it('says where each one sits, by fingerprint', () => {
    expect(places(claude('user', `my key ${gh}`))).toEqual([
      ['prompt', 'github-token', fingerprint(gh)],
    ]);
    expect(
      places(
        claude('assistant', [
          { type: 'text', text: `found ${gh}` },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${aws}` } },
        ]),
      ),
    ).toEqual([
      ['assistant', 'github-token', fingerprint(gh)],
      ['tool-input', 'aws-access-key', fingerprint(aws)],
    ]);
    // Tool output is kept twice in one entry: it counts once, with the call it belongs to.
    const out = finder.find(
      claude('user', [{ type: 'tool_result', tool_use_id: 't1', content: gh }], {
        toolUseResult: { stdout: gh },
      }),
      '',
    );
    expect(out).toEqual([
      { fingerprint: fingerprint(gh), kinds: ['github-token'], place: 'tool-output', call: 't1' },
    ]);
    expect(fingerprint(gh)).toBe(createHash('sha256').update(gh).digest('hex').slice(0, 8));
  });

  it('reads Codex entries and skips the events that repeat them', () => {
    const item = (payload: object) => ({ type: 'response_item', payload });
    expect(
      places(item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: gh }] })),
    ).toEqual([['prompt', 'github-token', fingerprint(gh)]]);
    expect(
      places(
        item({
          type: 'function_call',
          call_id: 'c1',
          arguments: JSON.stringify({ command: ['bash', '-lc', `cat <<EOF\n${aws}\nEOF`] }),
        }),
      ),
    ).toEqual([['tool-input', 'aws-access-key', fingerprint(aws)]]);
    expect(places(item({ type: 'function_call_output', call_id: 'c1', output: gh }))).toEqual([
      ['tool-output', 'github-token', fingerprint(gh)],
    ]);
    expect(places({ type: 'event_msg', payload: { type: 'user_message', message: gh } })).toEqual(
      [],
    );
    expect(places({ type: 'compacted', payload: { message: gh } })).toEqual([]);
  });

  it('leaves out placeholders, encrypted blobs and images', () => {
    expect(places(claude('user', `ghp_${'x'.repeat(36)} AKIAIOSFODNN7EXAMPLE`))).toEqual([]);
    expect(
      places(claude('assistant', [{ type: 'thinking', thinking: 'hm', signature: gh }])),
    ).toEqual([]);
    expect(
      places(claude('user', [{ type: 'image', source: { type: 'base64', data: `x${gh}` } }])),
    ).toEqual([]);
    expect(places({ type: 'reasoning', encrypted_content: gh })).toEqual([]);
  });

  it('knows a private key by its body, also with line numbers from the Read tool', () => {
    const body = (seed: string) =>
      fake('', 200, seed, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
    const pem = (b: string) => [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      ...b.match(/.{1,64}/g)!,
      '-----END OPENSSH PRIVATE KEY-----',
    ];
    const plain = pem(body('k1')).join('\n');
    const numbered = pem(body('k1'))
      .map((l, i) => `${String(i + 1).padStart(6)}→${l}`)
      .join('\n');
    const a = finder.find(claude('user', plain), '');
    expect(a).toEqual([
      { fingerprint: fingerprint(body('k1')), kinds: ['private-key'], place: 'prompt' },
    ]);
    expect(finder.find(claude('user', numbered), '')).toEqual(a);
    // Two keys in one text are two secrets; a header with no key after it is none.
    const two = finder.find(claude('user', `${plain}\n${pem(body('k2')).join('\n')}`), '');
    expect(two.map((f) => f.fingerprint)).toEqual([
      fingerprint(body('k1')),
      fingerprint(body('k2')),
    ]);
    expect(
      finder.find(claude('user', "if (s.includes('-----BEGIN RSA PRIVATE KEY-----'))"), ''),
    ).toEqual([]);
  });

  it('finds .env values whose name or shape says they are secret', () => {
    const project = path.join(tmp, 'app');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    const pass = fake('', 20, 'pw');
    const env = {
      API_TOKEN: fake('', 24, 'tok'),
      DATABASE_URL: `postgres://app:${pass}@db.internal:5432/app`,
      SITE_URL: 'https://shop.example.org/home',
      NEXT_PUBLIC_API_KEY: fake('', 24, 'pub'),
      APP_NAME: 'my-wonderful-app',
    };
    fs.writeFileSync(
      path.join(project, '.env'),
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    );
    const f = new TranscriptSecrets();
    const all = Object.values(env).join('\n');
    const line = JSON.stringify(claude('user', [{ type: 'tool_result', content: all }]));
    expect(f.mayHold(line, path.join(project, 'src'))).toBe(true);
    const found = f.find(JSON.parse(line), path.join(project, 'src'));
    expect(found.map((x) => kindName(x.kinds)).sort()).toEqual([
      'value of API_TOKEN from .env',
      'value of DATABASE_URL from .env',
    ]);
    expect(found.find((x) => x.kinds[0] === 'env:API_TOKEN')!.fingerprint).toBe(
      fingerprint(env.API_TOKEN),
    );
    // A value with a quote in it, as it sits in a raw JSON line.
    fs.writeFileSync(path.join(project, '.env'), `DB_PASSWORD='${pass}"x'\n`);
    const g = new TranscriptSecrets();
    expect(g.mayHold(JSON.stringify({ text: `pw ${pass}"x` }), project)).toBe(true);
  });

  it('never throws, whatever the entry holds', () => {
    let deep: unknown = gh;
    for (let i = 0; i < 10_000; i++) deep = [deep];
    for (const e of [null, 42, 'text', [], deep, { message: { content: { toString: 1 } } }])
      expect(() => finder.find(e, '/no/such/folder')).not.toThrow();
  });
});

describe('the tally', () => {
  it('adds up by fingerprint and keeps no value', () => {
    const t = new SecretTally();
    const base = {
      agent: 'claude-code' as const,
      session: 's1',
      cwd: '/w',
      kinds: ['github-token'],
    };
    for (const f of finder.find({ type: 'user', message: { content: `${gh} ${aws}` } }, ''))
      t.add({ ...base, ...f, file: '/h/a.jsonl', at: 1000 });
    t.add({
      ...base,
      fingerprint: fingerprint(gh),
      place: 'tool-output',
      file: '/h/b.jsonl',
      at: 5000,
    });
    const list = t.list();
    expect(t.size).toBe(2);
    expect(list[0]).toMatchObject({
      fingerprint: fingerprint(gh),
      count: 2,
      places: { prompt: 1, 'tool-output': 1 },
      first: 1000,
      last: 5000,
    });
    expect(list[0]!.transcripts.map((x) => x.file)).toEqual(['/h/b.jsonl', '/h/a.jsonl']);
    const text = JSON.stringify(list);
    expect(text).not.toContain(gh.slice(4, 12));
    expect(text).not.toContain(aws.slice(4, 12));
  });
});
