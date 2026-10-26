import fs from 'node:fs';
import path from 'node:path';
import type { Ecosystem, PackageRequest } from './requests.js';

/**
 * What the public registry says about a package name: missing, or when it was first
 * published. One small request per name, cached for a day, with a short deadline so a
 * slow network never holds up the agent for long. A failed lookup tells nothing and
 * leaves the call to the other rules.
 *
 * Established packages have big registry documents (many versions); reading stops after
 * a megabyte and counts such a package as established without parsing it.
 */

export interface PackageFact {
  missing?: boolean;
  /** First published, epoch ms. */
  created?: number;
  /** Too many versions to read: around for a long time. */
  established?: boolean;
}

export type Fetcher = (url: string, opts: { signal: AbortSignal }) => Promise<Response>;

const DEADLINE_MS = 2500;
const MAX_BYTES = 1024 * 1024;
const TTL_MS = 24 * 60 * 60 * 1000;
const TTL_MISSING_MS = 60 * 60 * 1000;

const URLS: Record<Ecosystem, (name: string) => string> = {
  npm: (name) => `https://registry.npmjs.org/${name.replace('/', '%2F')}`,
  pypi: (name) => `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
};

interface Cached extends PackageFact {
  at: number;
}

function cacheFile(belaydHome: string): string {
  return path.join(belaydHome, 'cache', 'packages.json');
}

function readCache(belaydHome: string): Record<string, Cached> {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(belaydHome), 'utf8')) as Record<string, Cached>;
  } catch {
    return {};
  }
}

/** Facts for each request, keyed `ecosystem:name`. Unknown when the lookup failed. */
export async function lookupPackages(
  requests: PackageRequest[],
  belaydHome: string,
  fetcher: Fetcher = fetch,
  now = Date.now(),
): Promise<Map<string, PackageFact>> {
  const facts = new Map<string, PackageFact>();
  if (requests.length === 0) return facts;
  const cache = readCache(belaydHome);
  let dirty = false;
  await Promise.all(
    requests.map(async (r) => {
      const key = `${r.ecosystem}:${r.name}`;
      const hit = cache[key];
      if (hit && now - hit.at < (hit.missing ? TTL_MISSING_MS : TTL_MS)) {
        facts.set(key, hit);
        return;
      }
      const fact = await lookup(URLS[r.ecosystem](r.name), r.ecosystem, fetcher);
      if (!fact) return;
      facts.set(key, fact);
      cache[key] = { ...fact, at: now };
      dirty = true;
    }),
  );
  if (dirty) {
    try {
      const file = cacheFile(belaydHome);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      // only costs a lookup next time
    }
  }
  return facts;
}

async function lookup(
  url: string,
  ecosystem: Ecosystem,
  fetcher: Fetcher,
): Promise<PackageFact | undefined> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DEADLINE_MS);
  try {
    const res = await fetcher(url, { signal: ctl.signal });
    if (res.status === 404) return { missing: true };
    if (!res.ok || !res.body) return undefined;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return { established: true };
      }
      chunks.push(value);
    }
    const doc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    const created = ecosystem === 'npm' ? npmCreated(doc) : pypiCreated(doc);
    return created !== undefined ? { created } : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function npmCreated(doc: Record<string, unknown>): number | undefined {
  const t = (doc.time as Record<string, unknown> | undefined)?.created;
  const ms = typeof t === 'string' ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

function pypiCreated(doc: Record<string, unknown>): number | undefined {
  let first = Infinity;
  for (const files of Object.values((doc.releases as Record<string, unknown>) ?? {})) {
    for (const f of Array.isArray(files) ? files : []) {
      const t = Date.parse(String((f as Record<string, unknown>).upload_time_iso_8601 ?? ''));
      if (Number.isFinite(t) && t < first) first = t;
    }
  }
  return Number.isFinite(first) ? first : undefined;
}
