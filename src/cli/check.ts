import path from 'node:path';
import pc from 'picocolors';
import { evaluate } from '../policy/engine.js';
import { loadPolicy } from '../policy/load.js';
import { makePackageCheck, prefetchPackages } from '../packages/check.js';
import type { Action, ActionContext, Decision, Verdict } from '../policy/types.js';
import { belaydHome, canonicalPath, findWorkspace, homeDir } from '../util/paths.js';

export interface CheckOptions {
  read?: string;
  write?: string;
  fetch?: string;
  cwd?: string;
  policy?: string;
  preset?: string;
  json?: boolean;
  explain?: boolean;
}

export async function check(commandWords: string[], opts: CheckOptions): Promise<number> {
  const action = toAction(commandWords, opts);
  if (!action) {
    console.error('Give a command to check, for example: belayd check "rm -rf ~"');
    return 64;
  }
  const cwd = canonicalPath(opts.cwd ?? process.cwd());
  const workspace = findWorkspace(cwd);
  const state = belaydHome();
  const policy = await loadPolicy({
    workspace,
    belaydHome: state,
    ...(opts.policy ? { policyPath: path.resolve(opts.policy) } : {}),
    ...(opts.preset ? { preset: opts.preset } : {}),
  });
  const ctx: ActionContext = { agent: 'cli', cwd, workspace, home: canonicalPath(homeDir()) };
  // The same registry lookups the hook makes, so a made-up package name shows here too.
  const facts = policy.packages.check
    ? await prefetchPackages(action, ctx, { belaydHome: state, env: process.env })
    : undefined;
  const decision = evaluate(action, ctx, policy, {
    belaydHome: state,
    ...(facts
      ? { unknownPackage: makePackageCheck({ workspace: ctx.workspace, env: process.env, facts }) }
      : {}),
  });

  if (opts.json) {
    console.log(JSON.stringify({ action, policy: policy.name, ...decision }, null, 2));
    return 0;
  }
  print(action, decision, policy.name, opts.explain ?? false);
  for (const w of policy.warnings) console.log(pc.yellow(`   ${w}`));
  return 0;
}

function toAction(words: string[], opts: CheckOptions): Action | undefined {
  if (opts.read) return { kind: 'read', path: opts.read };
  if (opts.write) return { kind: 'write', path: opts.write };
  if (opts.fetch) return { kind: 'fetch', url: opts.fetch };
  if (words.length === 0) return undefined;
  return { kind: 'shell', command: words.join(' ') };
}

const LOOK: Record<Verdict, { icon: string; color: (s: string) => string; word: string }> = {
  deny: { icon: '✖', color: pc.red, word: 'deny' },
  ask: { icon: '?', color: pc.yellow, word: 'ask' },
  allow: { icon: '✔', color: pc.green, word: 'allow' },
  pass: { icon: '·', color: pc.dim, word: 'pass' },
};

function print(action: Action, d: Decision, policyName: string, explain: boolean): void {
  const look = LOOK[d.verdict];
  const subject =
    action.kind === 'shell'
      ? action.command
      : `${action.kind} ${'path' in action ? action.path : 'url' in action ? action.url : ''}`;
  console.log(`${look.color(pc.bold(`${look.icon} ${look.word}`))}  ${subject}`);
  console.log(`   ${d.reason}`);
  const meta = [d.ruleId ? `rule ${d.ruleId}` : undefined, `policy: ${policyName}`]
    .filter(Boolean)
    .join('  ·  ');
  console.log(pc.dim(`   ${meta}`));
  if (explain && d.subjects.length > 0) {
    console.log('');
    console.log(pc.dim('   checked:'));
    for (const s of d.subjects) {
      const l = LOOK[s.verdict];
      const via = s.via.length > 0 ? pc.dim(` (via ${s.via.join(' > ')})`) : '';
      const rule = s.ruleId ? pc.dim(`  ${s.ruleId}`) : '';
      console.log(`   ${l.color(l.icon)} ${oneLine(s.label)}${via}${rule}`);
    }
  }
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 100 ? `${t.slice(0, 97)}...` : t;
}
