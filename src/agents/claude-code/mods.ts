import fs from 'node:fs';
import path from 'node:path';

/**
 * Claude Code mods (v2.1.287 and later) are plugins whose JavaScript runs inside Claude
 * Code. A mod that handles `tool.check` can approve a call that belayd's PreToolUse hook
 * blocked, and one that handles `classic.PreToolUse` sees and can change belayd's own
 * hook event, unless Claude Code loads its built-in guard: on a machine with managed
 * settings, or with a Team or Enterprise login. `belayd doctor` lists such mods.
 *
 * A mod is a plugin directory whose `hooks/hooks.json` has a `modules` list. Claude Code
 * requires event names to be string literals in `on('event', ...)`, so reading the source
 * finds every event a mod handles.
 */

/** Events whose handlers can overrule or change belayd's decision. */
const OVERRULING = new Set(['tool.check', 'classic.PreToolUse', 'classic.*', '*']);
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const ON_EVENT = /\bon\(\s*(['"`])([^'"`\s]{1,80})\1/g;

const MAX_DEPTH = 6;
const MAX_ENTRIES = 20_000;
const MAX_SOURCE_FILES = 200;
const MAX_SOURCE_BYTES = 1024 * 1024;

export interface Mod {
  name: string;
  dir: string;
  /** Events it handles that can overrule belayd. Empty: it cannot. */
  overrules: string[];
}

export interface ModSearch {
  configDir: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}

/** Every mod Claude Code can load on this machine for this project, by directory. */
export function findMods(opts: ModSearch): Mod[] {
  const roots = new Set<string>([
    path.join(opts.configDir, 'plugins'),
    // Mods Claude writes during a session: dev-mods/<session id>/<mod>/
    path.join(opts.configDir, 'dev-mods'),
    // Skills-directory plugins: a skill folder with a .claude-plugin/plugin.json
    path.join(opts.configDir, 'skills'),
    path.join(opts.workspace, '.claude', 'skills'),
  ]);
  for (const name of [
    'CLAUDE_CODE_PLUGIN_DIRS',
    'CLAUDE_CODE_PLUGIN_SEED_DIR',
    'CLAUDE_CODE_PLUGIN_CACHE_DIR',
  ]) {
    for (const dir of (opts.env[name] ?? '').split(path.delimiter)) {
      if (dir && path.isAbsolute(dir)) roots.add(dir);
    }
  }
  const seen = new Set<string>();
  const mods: Mod[] = [];
  for (const root of roots) {
    for (const hooksJson of findHooksFiles(root)) {
      const dir = path.dirname(path.dirname(hooksJson));
      if (seen.has(dir) || !isMod(hooksJson)) continue;
      seen.add(dir);
      mods.push({ name: pluginName(dir), dir, overrules: overrulingEvents(dir) });
    }
  }
  return mods;
}

/** The managed settings file Claude Code reads on this platform, if there is one. */
export function managedSettingsFile(): string | undefined {
  const base =
    process.platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode'
      : process.platform === 'win32'
        ? 'C:\\Program Files\\ClaudeCode'
        : '/etc/claude-code';
  for (const candidate of [
    path.join(base, 'managed-settings.json'),
    path.join(base, 'managed-settings.d'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function findHooksFiles(root: string): string[] {
  const out: string[] = [];
  let entries = 0;
  // A root can be a plugin itself (CLAUDE_CODE_PLUGIN_DIRS names plugin folders).
  const own = path.join(root, 'hooks', 'hooks.json');
  if (fs.existsSync(own)) out.push(own);
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || entries > MAX_ENTRIES) return;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      entries++;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const hooksJson = path.join(full, 'hooks', 'hooks.json');
        if (fs.existsSync(hooksJson)) out.push(hooksJson);
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

function isMod(hooksJson: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(hooksJson, 'utf8')) as { modules?: unknown };
    return Array.isArray(parsed.modules) && parsed.modules.length > 0;
  } catch {
    return false;
  }
}

function pluginName(dir: string): string {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name?: unknown };
    if (typeof manifest.name === 'string' && manifest.name) return manifest.name;
  } catch {
    // no manifest: use the folder name
  }
  return path.basename(dir);
}

/** The overruling events any source file in the mod registers, in a stable order. */
function overrulingEvents(dir: string): string[] {
  const found = new Set<string>();
  let files = 0;
  const walk = (d: string, depth: number) => {
    if (depth > MAX_DEPTH || files > MAX_SOURCE_FILES) return;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        // Generated type declarations and dependencies are not the mod's code.
        if (e.name !== 'node_modules' && e.name !== 'types' && e.name !== '.git')
          walk(full, depth + 1);
        continue;
      }
      if (!e.isFile() || !SOURCE.test(e.name) || /\.test\.[jt]sx?$/.test(e.name)) continue;
      files++;
      let text: string;
      try {
        if (fs.statSync(full).size > MAX_SOURCE_BYTES) continue;
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      for (const m of text.matchAll(ON_EVENT)) if (OVERRULING.has(m[2]!)) found.add(m[2]!);
    }
  };
  walk(dir, 0);
  return [...found].sort();
}
