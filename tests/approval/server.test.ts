import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serve } from '../../src/approval/server.js';
import { createRequest, newId, readDecision } from '../../src/approval/store.js';
import { createLinkKey, readUiState } from '../../src/approval/ui-state.js';

let home: string;
let server: Awaited<ReturnType<typeof serve>>;
let base: string;
let session: string;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'belayd-ui-'));
  server = await serve({ belaydHome: home, port: 0 });
  base = `http://127.0.0.1:${server.port}`;
  // Sign in the way a person does: open a one-time link from belayd ui.
  const res = await fetch(`${base}/?k=${createLinkKey(home)}`, { redirect: 'manual' });
  session = /belayd_ui=([a-f0-9]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
});
afterEach(async () => {
  await server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const cookie = () => `belayd_ui=${session}`;
const pending = () => {
  const id = newId();
  createRequest(home, {
    id,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    agent: 'codex',
    workspace: '/w',
    cwd: '/w',
    label: 'sudo ls',
    kind: 'shell',
    reason: 'Runs a command as another user',
    pid: process.pid,
  });
  return id;
};
const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/decide`, {
    method: 'POST',
    headers: { cookie: cookie(), 'content-type': 'application/json', 'x-belayd': '1', ...headers },
    body: JSON.stringify(body),
  });

describe('approval page server', () => {
  it('records where it listens', () => {
    expect(readUiState(home)?.port).toBe(server.port);
  });

  it('turns away requests without the key', async () => {
    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
  });

  it('rejects a made-up link key', async () => {
    expect((await fetch(`${base}/?k=${'a'.repeat(48)}`, { redirect: 'manual' })).status).toBe(403);
  });

  it('trades a link key for a strict session cookie, once', async () => {
    const key = createLinkKey(home);
    const res = await fetch(`${base}/?k=${key}`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/);
    expect(res.headers.get('set-cookie')).not.toContain(key);
    expect((await fetch(`${base}/?k=${key}`, { redirect: 'manual' })).status).toBe(403);
  });

  it('serves the page with a strict content security policy', async () => {
    const res = await fetch(`${base}/`, { headers: { cookie: cookie() } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(await res.text()).toMatch(/belay<b>d<\/b>/);
  });

  it('blocks DNS rebinding through the Host header', async () => {
    // fetch() will not send a custom Host header, so use node:http directly.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/api/state',
          headers: { cookie: cookie(), host: 'evil.example' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it('lists pending requests and accepts an answer once', async () => {
    const id = pending();
    const res = await fetch(`${base}/api/state`, { headers: { cookie: cookie() } });
    const state = (await res.json()) as { pending: { id: string }[] };
    expect(state.pending[0]?.id).toBe(id);
    expect((await post({ id, decision: 'allow' })).status).toBe(200);
    expect(readDecision(home, id)?.by).toBe('web');
    expect((await post({ id, decision: 'deny' })).status).toBe(409);
  });

  it('requires the custom header that other websites cannot send', async () => {
    const id = pending();
    expect((await post({ id, decision: 'allow' }, { 'x-belayd': '' })).status).toBe(400);
    expect(readDecision(home, id)).toBeUndefined();
  });

  it('rejects other origins', async () => {
    const id = pending();
    expect((await post({ id, decision: 'allow' }, { origin: 'https://evil.example' })).status).toBe(
      403,
    );
  });
});
