import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvValues, redact } from '../secrets/detect.js';
import { AuditLog, type AuditEvent, type StoredEvent } from './db.js';

const MAX_VALUE = 2000;
const MAX_INPUT = 8000;

/**
 * Writes one event. Auditing must never change a decision or crash a hook, so
 * failures are written to $BELAYD_HOME/errors.log and reported by `belayd doctor`.
 */
export async function record(
  belaydHome: string,
  event: AuditEvent,
): Promise<StoredEvent | undefined> {
  let log: AuditLog | undefined;
  try {
    const env = loadEnvValues(event.workspace);
    const safe: AuditEvent = {
      ...event,
      ...(event.label !== undefined ? { label: redact(event.label, env) } : {}),
      ...(event.input !== undefined ? { input: redact(event.input, env) } : {}),
      ...(event.reason !== undefined ? { reason: redact(event.reason, env) } : {}),
    };
    log = await AuditLog.open(belaydHome);
    return log.append(safe);
  } catch (err) {
    logError(belaydHome, `audit: ${(err as Error).message}`);
    return undefined;
  } finally {
    log?.close();
  }
}

/** Tool input as JSON, with file contents and other long values replaced by size and hash. */
export function summarizeInput(input: unknown): string {
  const shorten = (v: unknown): unknown => {
    if (typeof v === 'string' && v.length > MAX_VALUE) {
      const sha = crypto.createHash('sha256').update(v).digest('hex').slice(0, 12);
      return `[${v.length} chars, sha256 ${sha}]`;
    }
    if (Array.isArray(v)) return v.map(shorten);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shorten(x)]),
      );
    }
    return v;
  };
  let json: string;
  try {
    json = JSON.stringify(shorten(input)) ?? '';
  } catch {
    json = String(input);
  }
  return json.length > MAX_INPUT ? `${json.slice(0, MAX_INPUT - 3)}...` : json;
}

export function sessionKey(agent: string, sessionId: string | undefined): string {
  if (sessionId) return `${agent}:${sessionId}`;
  const day = new Date().toISOString().slice(0, 10);
  return `${agent}:no-session-${day}`;
}

export function logError(belaydHome: string, message: string): void {
  try {
    fs.mkdirSync(belaydHome, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(belaydHome, 'errors.log'),
      `${new Date().toISOString()} ${message}\n`,
      {
        mode: 0o600,
      },
    );
  } catch {
    // nowhere left to report
  }
}
