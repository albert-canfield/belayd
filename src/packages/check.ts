import { buildSubjects, type Subject } from '../policy/subjects.js';
import type { Action, ActionContext } from '../policy/types.js';
import { lookupPackages, type Fetcher, type PackageFact } from './registry.js';
import { requestedPackages } from './requests.js';

/**
 * Packages nobody has heard of (rule ask-unknown-package): a name the public registry
 * does not know, or one first published in the last month, that the project does not
 * have yet. The registry lookups happen before the policy is evaluated (the hook is
 * async, matching is not); the rule then reads their results.
 */

/** A package this young is asked about. */
const NEW_FOR_MS = 30 * 24 * 60 * 60 * 1000;
const MANAGERS = /\b(npm|npx|pnpm|pnpx|yarn|bun|bunx|pip[0-9.]*|pipx|uv|uvx|poetry)\b/;

/** Looks up every package this action would install that the project does not have yet. */
export async function prefetchPackages(
  action: Action,
  ctx: ActionContext,
  opts: {
    belaydHome: string;
    env: NodeJS.ProcessEnv;
    sessionWrites?: Set<string>;
    fetcher?: Fetcher;
  },
): Promise<Map<string, PackageFact>> {
  if (action.kind !== 'shell' || !MANAGERS.test(action.command)) return new Map();
  const seen = new Map<string, { ecosystem: 'npm' | 'pypi'; name: string }>();
  for (const s of buildSubjects(action, ctx, opts.sessionWrites)) {
    for (const r of requestedPackages(s, ctx.workspace, opts.env))
      seen.set(`${r.ecosystem}:${r.name}`, r);
  }
  return lookupPackages([...seen.values()], opts.belaydHome, opts.fetcher);
}

/** A check to pass to `evaluate`: why this subject installs a package nobody has heard of. */
export function makePackageCheck(opts: {
  workspace: string;
  env: NodeJS.ProcessEnv;
  facts: Map<string, PackageFact>;
  now?: number;
}): (s: Subject) => string | undefined {
  const now = opts.now ?? Date.now();
  return (s) => {
    if (opts.facts.size === 0) return undefined;
    const notes: string[] = [];
    for (const r of requestedPackages(s, opts.workspace, opts.env)) {
      const fact = opts.facts.get(`${r.ecosystem}:${r.name}`);
      const where = r.ecosystem === 'npm' ? 'npm' : 'PyPI';
      if (fact?.missing) notes.push(`${where} has no package called ${r.name}`);
      else if (fact?.created !== undefined && now - fact.created < NEW_FOR_MS) {
        const days = Math.max(0, Math.floor((now - fact.created) / 86_400_000));
        notes.push(
          `${r.name} first appeared on ${where} ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}`,
        );
      }
    }
    return notes.length > 0 ? notes.join('; ') : undefined;
  };
}
