import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { shellQuote } from '../agents/common.js';
import { optionRunsCode } from '../policy/gitconfig.js';

/**
 * What a project brings that can run code or steer an agent, read from its files without
 * running anything: Git options that run a command, hooks and plugins in each agent's
 * project settings, MCP servers, subagent and skill definitions, editor tasks that run
 * when the folder opens. A cloned repository can carry any of these (GitSpawn, a
 * malicious subagent file, a hook in `.claude/settings.json`), and they act before the
 * agent's first command or behind it.
 *
 * Each item has a stable key and a hash of what it does, so belayd can tell what is new
 * or changed since the person last looked (src/preflight/check.ts).
 */

export interface SetupItem {
  key: string;
  /** What a person sees: where it is and what it does. */
  label: string;
  hash: string;
}

/** Recognises belayd's own hook commands, which are not news. */
export type OwnCommand = (command: string) => boolean;

const MAX_FILE = 512 * 1024;
const MAX_LABEL = 100;

export function inventory(workspace: string, own: OwnCommand): SetupItem[] {
  const items: SetupItem[] = [];
  const add = (key: string, label: string, content: string) =>
    items.push({ key, label, hash: sha(content) });

  gitConfig(workspace, add);

  // Agents' project settings: hook commands, and settings that run code or widen access.
  for (const rel of [
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.codex/hooks.json',
    '.gemini/settings.json',
    '.cursor/hooks.json',
    '.github/copilot/settings.json',
    '.github/copilot/settings.local.json',
    ...listDir(workspace, '.github/hooks')
      .filter((f) => f.endsWith('.json'))
      .map((f) => `.github/hooks/${f}`),
  ]) {
    const json = readJson(path.join(workspace, rel));
    if (json === undefined) continue;
    for (const cmd of hookCommands(json)) {
      if (own(cmd)) continue;
      add(`hook:${rel}:${sha(cmd).slice(0, 12)}`, `${rel}: a hook runs \`${short(cmd)}\``, cmd);
    }
    if (rel.startsWith('.claude/')) claudeSettings(rel, json as Record<string, unknown>, add);
    if (rel === '.gemini/settings.json') mcpServers(rel, json, add);
  }

  // MCP servers a project declares.
  for (const rel of ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json']) {
    const json = readJson(path.join(workspace, rel));
    if (json !== undefined) mcpServers(rel, json, add);
  }

  // Subagents and skills steer the agent; a skill folder can also carry code.
  for (const f of listDir(workspace, '.claude/agents').filter((f) => f.endsWith('.md'))) {
    const rel = `.claude/agents/${f}`;
    const text = readText(path.join(workspace, rel));
    if (text !== undefined)
      add(`agent:${rel}`, `${rel}: a subagent the agent can hand work to`, text);
  }
  for (const dir of listDir(workspace, '.claude/skills')) {
    const rel = `.claude/skills/${dir}`;
    const files = treeHash(path.join(workspace, rel));
    if (files !== undefined) add(`skill:${rel}`, `${rel}: a skill the agent can load`, files);
  }

  // OpenCode plugins run inside OpenCode.
  for (const f of listDir(workspace, '.opencode/plugins')) {
    const rel = `.opencode/plugins/${f}`;
    const text = readText(path.join(workspace, rel));
    if (text === undefined || text.includes('belayd-opencode-plugin')) continue;
    add(`plugin:${rel}`, `${rel}: an OpenCode plugin`, text);
  }
  for (const rel of ['opencode.json', 'opencode.jsonc']) {
    const json = readJson(path.join(workspace, rel)) as { plugin?: unknown } | undefined;
    for (const name of Array.isArray(json?.plugin) ? json.plugin : []) {
      if (typeof name === 'string')
        add(`plugin:${rel}:${name}`, `${rel}: loads the OpenCode plugin ${short(name)}`, name);
    }
  }

  // VS Code (and forks) run these tasks as soon as the folder opens.
  const tasks = readJson(path.join(workspace, '.vscode/tasks.json')) as
    { tasks?: unknown } | undefined;
  for (const task of Array.isArray(tasks?.tasks) ? tasks.tasks : []) {
    const t = task as Record<string, unknown>;
    const runOn = (t.runOptions as Record<string, unknown> | undefined)?.runOn;
    if (runOn !== 'folderOpen') continue;
    const cmd = [t.command, ...(Array.isArray(t.args) ? t.args : [])]
      .filter((x) => typeof x === 'string')
      .join(' ');
    const name = typeof t.label === 'string' ? t.label : cmd;
    add(
      `task:.vscode/tasks.json:${name}`,
      `.vscode/tasks.json: task "${short(name)}" runs \`${short(cmd)}\` when the folder opens`,
      JSON.stringify(t),
    );
  }
  return items;
}

/** Command-running options in the repository's own config, and the files it includes. */
function gitConfig(workspace: string, add: (k: string, l: string, c: string) => void): void {
  let gitDir = path.join(workspace, '.git');
  try {
    const st = fs.lstatSync(gitDir);
    if (st.isFile()) {
      // A worktree or submodule: `.git` names the real folder.
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!m) return;
      gitDir = path.resolve(workspace, m[1]!.trim());
    } else if (!st.isDirectory()) return;
  } catch {
    return;
  }
  const text = readText(path.join(gitDir, 'config'));
  if (text === undefined) return;
  for (const { key, value } of parseGitConfig(text)) {
    const k = key.toLowerCase();
    if (k === 'include.path' || (k.startsWith('includeif.') && k.endsWith('.path'))) {
      add(
        `git:${key}=${value}`,
        `.git/config: includes another config file, ${short(value)}`,
        value,
      );
      continue;
    }
    const why = optionRunsCode(key, value);
    if (why) add(`git:${key}`, `.git/config: ${short(why)}`, value);
  }
}

/** `section.subsection.key = value` pairs of a Git config file, simply parsed. */
export function parseGitConfig(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const head = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (head) {
      section = head[2] !== undefined ? `${head[1]}.${head[2]}` : head[1]!;
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!kv || !section) continue;
    let value = (kv[2] ?? 'true').replace(/\s+[#;].*$/, '').trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    out.push({ key: `${section}.${kv[1]}`, value });
  }
  return out;
}

/**
 * Every command under a `hooks` key, in any agent's settings format. An exec-form entry
 * (`command` plus an `args` list, as belayd installs for newer Claude Code) is read as one
 * command line, quoted the way belayd writes it.
 */
function hookCommands(json: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, inHooks: boolean, depth: number) => {
    if (depth > 12 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, inHooks, depth + 1);
      return;
    }
    const entry = v as Record<string, unknown>;
    if (inHooks && typeof entry.command === 'string' && Array.isArray(entry.args)) {
      out.push([entry.command, ...entry.args.map(String)].map(shellQuote).join(' '));
      return;
    }
    for (const [k, x] of Object.entries(entry)) {
      if (inHooks && typeof x === 'string' && ['command', 'bash', 'powershell'].includes(k))
        out.push(x);
      else walk(x, inHooks || k === 'hooks', depth + 1);
    }
  };
  walk(json, false, 0);
  return out;
}

/** Claude Code settings that run a command or widen what the agent may do. */
function claudeSettings(
  rel: string,
  s: Record<string, unknown>,
  add: (k: string, l: string, c: string) => void,
): void {
  const perms = s.permissions as Record<string, unknown> | undefined;
  if (perms?.defaultMode === 'bypassPermissions')
    add(
      `claude:${rel}:bypass`,
      `${rel}: starts Claude Code with its permission checks off`,
      'bypass',
    );
  for (const key of [
    'apiKeyHelper',
    'awsAuthRefresh',
    'awsCredentialExport',
    'otelHeadersHelper',
  ]) {
    if (typeof s[key] === 'string')
      add(
        `claude:${rel}:${key}`,
        `${rel}: ${key} runs \`${short(s[key] as string)}\``,
        s[key] as string,
      );
  }
  const status = (s.statusLine as Record<string, unknown> | undefined)?.command;
  if (typeof status === 'string')
    add(`claude:${rel}:statusLine`, `${rel}: the status line runs \`${short(status)}\``, status);
  if (s.env && typeof s.env === 'object') {
    // Names only in the label: values can be secrets.
    const env = s.env as Record<string, unknown>;
    const names = Object.keys(env).sort();
    if (names.length > 0)
      add(
        `claude:${rel}:env`,
        `${rel}: sets ${short(names.join(', '))} for every command`,
        JSON.stringify(names.map((n) => [n, env[n]])),
      );
  }
  if (s.enableAllProjectMcpServers === true)
    add(`claude:${rel}:allmcp`, `${rel}: turns on every MCP server the project declares`, 'all');
  for (const key of ['enabledPlugins', 'extraKnownMarketplaces']) {
    const v = s[key];
    if (v && typeof v === 'object')
      for (const name of Object.keys(v as object))
        add(
          `claude:${rel}:${key}:${name}`,
          `${rel}: ${key === 'enabledPlugins' ? 'turns on the plugin' : 'adds the plugin marketplace'} ${short(name)}`,
          JSON.stringify((v as Record<string, unknown>)[name]),
        );
  }
}

function mcpServers(rel: string, json: unknown, add: (k: string, l: string, c: string) => void) {
  const j = json as Record<string, unknown>;
  const servers = (j.mcpServers ?? j.servers) as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== 'object') return;
  for (const [name, def] of Object.entries(servers)) {
    const d = (def ?? {}) as Record<string, unknown>;
    const what =
      typeof d.command === 'string'
        ? `runs \`${short([d.command, ...(Array.isArray(d.args) ? d.args : [])].join(' '))}\``
        : typeof d.url === 'string'
          ? `connects to ${short(d.url)}`
          : 'is declared';
    add(`mcp:${rel}:${name}`, `${rel}: MCP server ${short(name)} ${what}`, JSON.stringify(d));
  }
}

function readText(file: string): string | undefined {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return undefined;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function readJson(file: string): unknown {
  const text = readText(file);
  if (text === undefined) return undefined;
  try {
    // Settings files may carry comments (JSONC).
    return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
  } catch {
    return undefined;
  }
}

function listDir(workspace: string, rel: string): string[] {
  try {
    return fs.readdirSync(path.join(workspace, rel)).sort();
  } catch {
    return [];
  }
}

/** One hash over a folder's files (names and contents), bounded. */
function treeHash(dir: string): string | undefined {
  const h = crypto.createHash('sha256');
  let files = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 4 || files > 200) return;
    let list: fs.Dirent[];
    try {
      list = fs
        .readdirSync(d, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of list) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) {
        files++;
        h.update(path.relative(dir, full))
          .update('\0')
          .update(readText(full) ?? '[large]')
          .update('\0');
      }
    }
  };
  walk(dir, 0);
  return files > 0 ? h.digest('hex') : undefined;
}

function sha(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function short(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > MAX_LABEL ? `${one.slice(0, MAX_LABEL - 1)}…` : one;
}
