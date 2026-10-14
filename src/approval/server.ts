import crypto from 'node:crypto';
import http from 'node:http';
import { renderPage } from './page.js';
import { decide, listPending, type ApprovalRequest } from './store.js';
import { clearUiState, consumeLinkKey, writeUiState } from './ui-state.js';

export interface ServeOptions {
  belaydHome: string;
  port: number;
  /** Exit after this long with nothing pending and no visits. */
  idleExitMs?: number;
  /** Try the next ports if this one is taken. */
  portAttempts?: number;
}

interface RecentItem {
  id: string;
  label: string;
  agent: string;
  outcome: 'allowed' | 'denied' | 'gone';
  at: number;
}

const COOKIE = 'belayd_ui';

/**
 * The local approval page. Only reachable on 127.0.0.1, only after opening the link
 * with the secret token (see `belayd ui`), and hardened against other websites:
 * a strict Host check stops DNS rebinding, a SameSite=Strict cookie plus a custom
 * header on every write stops cross-site requests.
 */
export async function serve(opts: ServeOptions): Promise<{ port: number; close(): Promise<void> }> {
  /** Session cookies handed out in exchange for a one-time link key. In memory only. */
  const sessions = new Set<string>();
  const recent: RecentItem[] = [];
  let known = new Map<string, ApprovalRequest>();
  let lastActivity = Date.now();
  let port = opts.port;

  const remember = (item: RecentItem) => {
    recent.unshift(item);
    recent.length = Math.min(recent.length, 30);
  };

  const refresh = (): ApprovalRequest[] => {
    const pending = listPending(opts.belaydHome);
    const ids = new Set(pending.map((p) => p.id));
    for (const [id, req] of known) {
      if (!ids.has(id) && !recent.some((r) => r.id === id)) {
        remember({ id, label: req.label, agent: req.agent, outcome: 'gone', at: Date.now() });
      }
    }
    known = new Map(pending.map((p) => [p.id, p]));
    return pending;
  };

  const server = http.createServer((req, res) => {
    lastActivity = Date.now();
    const send = (
      status: number,
      body: string,
      type = 'application/json',
      extra: Record<string, string> = {},
    ) => {
      res.writeHead(status, {
        'Content-Type': `${type}; charset=utf-8`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        ...extra,
      });
      res.end(body);
    };

    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return send(421, JSON.stringify({ error: 'wrong host' }));
    }

    const url = new URL(req.url ?? '/', `http://${host}`);
    const presented = cookie(req.headers.cookie, COOKIE);
    const authed = [...sessions].some((s) => safeEqual(presented, s));

    if (req.method === 'GET' && url.pathname === '/') {
      const k = url.searchParams.get('k');
      if (k !== null) {
        if (!consumeLinkKey(opts.belaydHome, k)) return send(403, page401(), 'text/html');
        const session = crypto.randomBytes(32).toString('hex');
        sessions.add(session);
        return send(303, '', 'text/plain', {
          'Set-Cookie': `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
          Location: '/',
        });
      }
      if (!authed) return send(401, page401(), 'text/html');
      const nonce = crypto.randomBytes(16).toString('base64');
      return send(200, renderPage(nonce), 'text/html', {
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }

    if (!authed) return send(401, JSON.stringify({ error: 'open this page with `belayd ui`' }));

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const now = Date.now();
      const pending = refresh().map((p) => ({
        id: p.id,
        agent: p.agent,
        label: p.label,
        kind: p.kind,
        reason: p.reason,
        ruleId: p.ruleId,
        workspace: p.workspace,
        cwd: p.cwd,
        remainingMs: Math.max(0, p.expiresAt - now),
      }));
      return send(200, JSON.stringify({ pending, recent }));
    }

    if (req.method === 'POST' && url.pathname === '/api/decide') {
      const origin = req.headers.origin;
      if (
        origin &&
        origin !== `http://127.0.0.1:${port}` &&
        origin !== `http://localhost:${port}`
      ) {
        return send(403, JSON.stringify({ error: 'bad origin' }));
      }
      if (
        req.headers['x-belayd'] !== '1' ||
        !String(req.headers['content-type']).startsWith('application/json')
      ) {
        return send(400, JSON.stringify({ error: 'bad request' }));
      }
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString('utf8');
        if (body.length > 10_000) req.destroy();
      });
      req.on('end', () => {
        try {
          const { id, decision } = JSON.parse(body) as { id?: string; decision?: string };
          if (typeof id !== 'string' || (decision !== 'allow' && decision !== 'deny')) {
            return send(400, JSON.stringify({ error: 'bad request' }));
          }
          const req0 = known.get(id);
          const ok = decide(opts.belaydHome, id, decision, 'web');
          if (ok && req0) {
            remember({
              id,
              label: req0.label,
              agent: req0.agent,
              outcome: decision === 'allow' ? 'allowed' : 'denied',
              at: Date.now(),
            });
          }
          return send(ok ? 200 : 409, JSON.stringify({ ok }));
        } catch {
          return send(400, JSON.stringify({ error: 'bad request' }));
        }
      });
      return;
    }

    return send(404, JSON.stringify({ error: 'not found' }));
  });

  const attempts = opts.portAttempts ?? 10;
  for (let i = 0; ; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || i >= attempts - 1) throw err;
      port++;
    }
  }
  const address = server.address();
  if (address && typeof address === 'object') port = address.port;

  writeUiState(opts.belaydHome, { pid: process.pid, port, startedAt: Date.now() });

  const idleExitMs = opts.idleExitMs ?? 30 * 60_000;
  const timer = setInterval(() => {
    if (Date.now() - lastActivity > idleExitMs && listPending(opts.belaydHome).length === 0) {
      void close().then(() => process.exit(0));
    }
  }, 30_000);
  timer.unref();

  const close = () =>
    new Promise<void>((resolve) => {
      clearInterval(timer);
      clearUiState(opts.belaydHome, process.pid);
      server.close(() => resolve());
      server.closeAllConnections();
    });

  return { port, close };
}

function cookie(header: string | undefined, name: string): string {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function page401(): string {
  return `<!doctype html><meta charset="utf-8"><title>belayd</title>
<body style="font:16px system-ui;margin:4rem auto;max-width:32rem;padding:0 1rem;color:#44403c">
<h1 style="font-size:1.25rem">This page needs a fresh link</h1>
<p>Run <code>belayd ui</code> in a terminal. It opens this page with a one-time link that unlocks it.</p>
</body>`;
}
