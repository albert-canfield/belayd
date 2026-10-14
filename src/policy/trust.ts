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

/**
 * Trust is keyed by the file's own path, with its folder resolved so /tmp and
 * /private/tmp are one entry. The file itself is not resolved: a belayd.yaml that is
 * a symlink to a trusted file elsewhere is a different file and starts untrusted.
 */
function key(file: string): string {
  const abs = path.resolve(file);
  return path.join(canonicalPath(path.dirname(abs)), path.basename(abs));
}

export function contentHash(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** The content hash you trusted for this file, if any. */
export function trustedHash(belaydHome: string, file: string): string | undefined {
  return read(belaydHome)[key(file)];
}

/** Pass the content you already read, so the check and the use see the same bytes. */
export function isTrusted(belaydHome: string, file: string, content?: string | Buffer): boolean {
  try {
    return trustedHash(belaydHome, file) === contentHash(content ?? fs.readFileSync(file));
  } catch {
    return false;
  }
}

/** Trusts exactly the content that was shown, not whatever the file holds a moment later. */
export function trustFile(belaydHome: string, file: string, content?: string | Buffer): void {
  const data = read(belaydHome);
  data[key(file)] = contentHash(content ?? fs.readFileSync(file));
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
