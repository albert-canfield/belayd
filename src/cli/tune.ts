import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import pc from 'picocolors';
import { isMap, isSeq, parseDocument, YAMLSeq, type YAMLMap } from 'yaml';
import { AuditLog } from '../audit/db.js';
import { DEFAULT_MIN_APPROVALS, suggestRules, type Suggestion } from '../policy/learn.js';
import { loadPolicy, POLICY_FILE, readPolicyText } from '../policy/load.js';
import { isTrusted, trustFile } from '../policy/trust.js';
import { belaydHome, findWorkspace, homeDir } from '../util/paths.js';
import { insideAgent } from './approve.js';

export interface TuneOptions {
  min?: string;
  global?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

/** `belayd tune`: suggests allow rules for questions you keep answering with yes. */
export async function tune(opts: TuneOptions): Promise<number> {
  const min = opts.min === undefined ? DEFAULT_MIN_APPROVALS : Number(opts.min);
  if (!Number.isInteger(min) || min < 1) {
    console.error('--min takes a whole number of approvals, 1 or more.');
    return 64;
  }
  const home = belaydHome();
  const workspace = findWorkspace(process.cwd());
  if (!AuditLog.exists(home)) {
    console.log('Nothing to learn from yet: belayd has not recorded any tool calls.');
    return 0;
  }

  const log = await AuditLog.open(home, { readOnly: true });
  let suggestions: Suggestion[];
  try {
    suggestions = await suggestRules({
      events: log.events(opts.global ? {} : { workspace }),
      belaydHome: home,
      home: homeDir(),
      min,
      relativeToWorkspace: !opts.global,
      policyFor: (ws) => loadPolicy({ workspace: ws, belaydHome: home }),
    });
  } finally {
    log.close();
  }

  const where = opts.global ? 'all projects' : path.basename(workspace);
  if (suggestions.length === 0) {
    console.log(
      `Nothing to suggest for ${where}: no question was approved ${min} times or more.` +
        pc.dim(' (Only questions belayd could see all of are learned. See belayd tune --help.)'),
    );
    return 0;
  }

  const target = targetFile(home, workspace, opts.global === true);
  console.log(
    pc.bold(
      `belayd tune · ${where} · ${suggestions.length} ${plural(suggestions.length, 'suggestion')}`,
    ),
  );
  console.log(pc.dim('Each one allows exactly that command or file, and nothing else.\n'));
  suggestions.forEach((s, i) => {
    console.log(`${pc.bold(String(i + 1).padStart(2))}  ${s.label}`);
    console.log(
      pc.dim(
        `    you approved it ${s.count} times, last ${new Date(s.lastAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · asked by ${s.askedBy}`,
      ),
    );
  });
  console.log('');

  if (opts.dryRun) return 0;
  if (!target.file) {
    console.log(target.why);
    return 0;
  }
  if (insideAgent(process.env)) {
    console.error('belayd tune must be run by a person, not from inside an agent session.');
    return 77;
  }

  const chosen: Suggestion[] = [];
  if (opts.yes) chosen.push(...suggestions);
  else if (!process.stdin.isTTY) {
    console.log(`Not running in a terminal. Run belayd tune --yes to add all of them.`);
    return 0;
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const [i, s] of suggestions.entries()) {
        const a = (await rl.question(`Allow ${i + 1} (${short(s.label)})? [y/N] `)).trim();
        if (/^y(es)?$/i.test(a)) chosen.push(s);
      }
    } finally {
      rl.close();
    }
  }
  if (chosen.length === 0) {
    console.log('Nothing added.');
    return 0;
  }

  const added = addRules(target.file, chosen);
  // You reviewed what went in, so a file that was trusted stays trusted.
  if (target.retrust) trustFile(home, target.file, readPolicyText(target.file));
  console.log(
    pc.green(
      `✔ Added ${added} ${plural(added, 'rule')} to ${tildeOrRelative(target.file, workspace)}. belayd will stop asking about ${added === 1 ? 'it' : 'them'}.`,
    ),
  );
  console.log(pc.dim('  Each one is marked "Learned with belayd tune"; delete it there to undo.'));
  return 0;
}

/**
 * Learned rules go where they apply: this project's own belayd.yaml, if you trust it.
 * A file you have not trusted is never edited: trusting it again would also trust
 * whatever else is in it. Rules for all projects go in your own file.
 */
function targetFile(
  home: string,
  workspace: string,
  global: boolean,
): { file?: string; retrust: boolean; why?: string } {
  if (global) return { file: path.join(home, POLICY_FILE), retrust: false };
  const file = path.join(workspace, POLICY_FILE);
  if (!fs.existsSync(file))
    return {
      retrust: false,
      why:
        'This project has no belayd.yaml of its own, so there is nowhere to put rules just for it.\n' +
        'Run belayd init here first, or belayd tune --global to add them to your own policy for every project.',
    };
  if (!isTrusted(home, file))
    return {
      retrust: false,
      why:
        "This project's belayd.yaml is not trusted, so belayd tune will not edit it.\n" +
        'Review it and run belayd trust first, or use belayd tune --global.',
    };
  return { file, retrust: true };
}

function addRules(file: string, chosen: Suggestion[]): number {
  const text = fs.existsSync(file)
    ? readPolicyText(file)
    : '# Your own belayd policy. It applies in every project.\nversion: 1\n';
  const doc = parseDocument(text);
  if (!isMap(doc.contents)) throw new Error(`${file} is not a belayd policy`);
  const found = doc.get('rules', true);
  const seq = isSeq(found) ? found : new YAMLSeq();
  if (seq !== found) doc.set('rules', seq);
  // `rules: []` is a flow list; new rules read better as a block.
  seq.flow = false;
  const ids = new Set(seq.items.map((r) => (isMap(r) ? String(r.get('id')) : '')));
  let added = 0;
  for (const s of chosen) {
    if (ids.has(s.rule.id)) continue;
    const node = doc.createNode(s.rule) as YAMLMap;
    const match = node.get('match', true);
    if (isMap(match)) for (const item of match.items) if (isSeq(item.value)) item.value.flow = true;
    node.commentBefore = ` ${s.label}`;
    seq.items.push(node);
    added++;
  }
  const out = doc.toString({ lineWidth: 0 });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);
  return added;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function short(label: string): string {
  const one = label.replace(/\s+/g, ' ');
  return one.length > 60 ? `${one.slice(0, 57)}...` : one;
}

function tildeOrRelative(file: string, workspace: string): string {
  const rel = path.relative(workspace, file);
  if (rel && !rel.startsWith('..')) return rel;
  const h = homeDir();
  return file.startsWith(h + path.sep) ? `~${file.slice(h.length)}` : file;
}
