import fs from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../../src/policy/engine.js';
import { loadPolicy, type CompiledPolicy } from '../../src/policy/load.js';
import type { Action, ActionContext, Verdict } from '../../src/policy/types.js';

interface Row {
  cmd?: string;
  read?: string;
  write?: string;
  fetch?: string;
  mcp?: { server: string; tool: string; args: unknown };
  balanced: Verdict;
  strict?: Verdict;
  yolo?: Verdict;
  note?: string;
}

type PresetKey = 'balanced' | 'strict' | 'yolo';

const rows = parse(fs.readFileSync(new URL('./corpus.yaml', import.meta.url), 'utf8')) as Row[];

const ctx: ActionContext = {
  agent: 'cli',
  cwd: '/work/app',
  workspace: '/work/app',
  home: '/home/dev',
};
const opts = { belaydHome: '/home/dev/.belayd' };
const load = (preset: string) =>
  loadPolicy({ workspace: ctx.workspace, belaydHome: opts.belaydHome, preset, noCache: true });
const policies: Record<PresetKey, CompiledPolicy> = {
  balanced: await load('balanced'),
  strict: await load('strict'),
  yolo: await load('yolo-with-undo'),
};

function actionOf(row: Row): Action {
  if (row.cmd !== undefined) return { kind: 'shell', command: row.cmd };
  if (row.read !== undefined) return { kind: 'read', path: row.read };
  if (row.write !== undefined) return { kind: 'write', path: row.write };
  if (row.fetch !== undefined) return { kind: 'fetch', url: row.fetch };
  if (row.mcp !== undefined) return { kind: 'mcp', ...row.mcp };
  throw new Error(`row without an action: ${JSON.stringify(row)}`);
}

function expected(row: Row, preset: PresetKey): Verdict {
  if (preset === 'balanced') return row.balanced;
  const explicit = row[preset];
  if (explicit) return explicit;
  if (row.balanced !== 'pass') return row.balanced;
  return preset === 'strict' ? 'ask' : 'allow';
}

function label(row: Row): string {
  const a = actionOf(row);
  const text =
    a.kind === 'shell'
      ? a.command
      : a.kind === 'mcp'
        ? `mcp ${a.server}.${a.tool} ${JSON.stringify(a.args)}`
        : `${a.kind} ${'path' in a ? a.path : 'url' in a ? a.url : ''}`;
  return text.replace(/\n/g, '\\n');
}

describe('policy corpus', () => {
  it('has a healthy number of rows', () => {
    expect(rows.length).toBeGreaterThan(200);
  });

  for (const preset of ['balanced', 'strict', 'yolo'] as const) {
    describe(preset, () => {
      for (const row of rows) {
        const want = expected(row, preset);
        it(`${want.padEnd(5)} ${label(row)}`, () => {
          const d = evaluate(actionOf(row), ctx, policies[preset], opts);
          expect(d.verdict, `${d.reason}${d.ruleId ? ` [${d.ruleId}]` : ''}`).toBe(want);
        });
      }
    });
  }
});
