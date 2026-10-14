import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath } from '../util/paths.js';

/**
 * Which project policy files you have reviewed, pinned by content hash, like direnv's
 * `direnv allow`. A belayd.yaml that arrives with a cloned repository is not trusted:
 * it can make belayd stricter, never weaker. Editing a trusted file untrusts it until
 * you run `belayd trust` again.
 */

function storeFile(belaydHome: string): string {
  return path.join(belaydHome, 'trusted.json');
}

function read(belaydHome: string): Record<string, string> {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(belaydHome), 'utf8')) as unknown;
    return data && typeof data === 'object' ? (data as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function write(belaydHome: string, data: Record<string, string>): void {
  fs.mkdirSync(belaydHome, { recursive: true, mode: 0o700 });
  const tmp = `${storeFile(belaydHome)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, storeFile(belaydHome));
}

/** Trust is keyed by where the file really is, so /tmp and /private/tmp are one entry. */
function key(file: string): string {
  return canonicalPath(file);
}

export function fileHash(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function isTrusted(belaydHome: string, file: string): boolean {
  try {
    return read(belaydHome)[key(file)] === fileHash(file);
  } catch {
    return false;
  }
}

export function trustFile(belaydHome: string, file: string): void {
  const data = read(belaydHome);
  data[key(file)] = fileHash(file);
  write(belaydHome, data);
}

export function revokeTrust(belaydHome: string, file: string): boolean {
  const data = read(belaydHome);
  const k = key(file);
  if (!(k in data)) return false;
  delete data[k];
  write(belaydHome, data);
  return true;
}

/** A short fingerprint of the trust entry, so the policy cache notices trust changes. */
export function trustKey(belaydHome: string, file: string): string {
  return read(belaydHome)[key(file)] ?? '';
}
