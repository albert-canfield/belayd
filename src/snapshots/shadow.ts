import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readRegularFile } from '../util/files.js';
import { canonicalPath, ensurePrivateDir } from '../util/paths.js';

/** Stands for a folder where a file was expected; equal to no blob id. */
const FOLDER = 'folder';

/**
 * Snapshots live in a shadow Git repository per workspace, under
 * $BELAYD_HOME/snapshots/<id>, with its own index. It never touches the project's
 * own .git: no refs, no objects, no index, no stash. It also works in folders that
 * are not Git repositories.
 */

export interface Snapshot {
  /** Git tree id of the snapshot. */
  tree: string;
  /** Workspace-relative paths, when only some files were captured. */
  paths?: string[];
  /** Files left out because they were too big. */
  skipped?: string[];
  /** For a whole-workspace snapshot: the paths that changed since the previous one. */
  changed?: string[];
}

export interface Change {
  path: string;
  /** A: created, M: modified, D: deleted, T: type changed. */
  status: 'A' | 'M' | 'D' | 'T';
  added?: number;
  removed?: number;
}

const DEFAULT_EXCLUDES = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '*.pyc',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.cache/',
  '.gradle/',
  'target/',
  '.DS_Store',
];

/** Config that keeps the user's Git setup from interfering with snapshots. */
const SAFE_CONFIG: Record<string, string> = {
  'core.bare': 'false',
  'core.autocrlf': 'false',
  'core.safecrlf': 'false',
  'core.fsmonitor': 'false',
  'core.hooksPath': '/dev/null',
  'core.quotepath': 'off',
  'core.untrackedCache': 'true',
  'gc.auto': '0',
  'commit.gpgSign': 'false',
  'status.showUntrackedFiles': 'all',
};

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export class SnapshotError extends Error {}

export class Shadow {
  readonly dir: string;
  readonly workspace: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly belaydHome: string,
    workspace: string,
    private readonly opts: {
      maxFileSize?: number;
      maxFiles?: number;
      /** Epoch ms by which a snapshot must be done (a hook has to answer the agent). */
      deadline?: number;
    } = {},
  ) {
    workspace = canonicalPath(workspace);
    this.workspace = workspace;
    const id = crypto.createHash('sha256').update(workspace).digest('hex').slice(0, 16);
    const name = path.basename(workspace).replace(/[^A-Za-z0-9._-]/g, '_') || 'root';
    this.dir = path.join(belaydHome, 'snapshots', `${name}-${id}`);
    // A clean environment: GIT_* variables inherited from the agent (for example
    // inside a git hook) must not point our commands at the user's repository.
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
    this.env = {
      ...env,
      GIT_DIR: this.dir,
      GIT_WORK_TREE: workspace,
      GIT_INDEX_FILE: path.join(this.dir, 'index'),
      GIT_LITERAL_PATHSPECS: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_NAME: 'belayd',
      GIT_AUTHOR_EMAIL: 'belayd@localhost',
      GIT_COMMITTER_NAME: 'belayd',
      GIT_COMMITTER_EMAIL: 'belayd@localhost',
      LC_ALL: 'C',
    };
  }

  static available(): boolean {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  exists(): boolean {
    return fs.existsSync(path.join(this.dir, 'HEAD'));
  }

  /** Creates the shadow repository on first use. */
  ensure(): void {
    if (this.exists()) {
      this.excludeOwnData();
      this.rawBytes();
      return;
    }
    ensurePrivateDir(this.belaydHome);
    ensurePrivateDir(path.dirname(this.dir));
    execFileSync('git', ['init', '--bare', '-q', this.dir], {
      env: this.cleanEnv(),
      stdio: 'ignore',
    });
    for (const [k, v] of Object.entries(SAFE_CONFIG)) this.git(['config', k, v]);
    const excludes = [...DEFAULT_EXCLUDES];
    const projectExclude = path.join(this.workspace, '.git', 'info', 'exclude');
    try {
      excludes.push(...readRegularFile(projectExclude, 1024 * 1024).text.split('\n'));
    } catch {
      // not a git repository, or no local excludes
    }
    fs.mkdirSync(path.join(this.dir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'info', 'exclude'), `${excludes.join('\n')}\n`);
    fs.writeFileSync(path.join(this.dir, 'belayd-workspace'), this.workspace);
    this.excludeOwnData();
    this.rawBytes();
  }

  /**
   * Snapshots store bytes exactly. Without this, a project's .gitattributes (text=auto,
   * eol, LFS filters) would change line endings or content on the way back.
   */
  private rawBytes(): void {
    const file = path.join(this.dir, 'info', 'attributes');
    const line = '* -text -filter -diff -merge -ident';
    try {
      if (fs.readFileSync(file, 'utf8').includes(line)) return;
    } catch {
      // not written yet
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${line}\n`);
  }

  /** belayd's own data inside the workspace, as a workspace-relative path. */
  private ownData(): string | undefined {
    return this.relative(canonicalPath(this.belaydHome));
  }

  /** Never snapshot belayd's own data, or each snapshot would contain the last one. */
  private excludeOwnData(): void {
    const own = this.ownData();
    if (!own) return;
    const file = path.join(this.dir, 'info', 'exclude');
    const line = `/${own}/`;
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!current.split('\n').includes(line)) fs.appendFileSync(file, `${line}\n`);
  }

  /** Captures the whole workspace. Cheap when nothing changed since the last snapshot. */
  snapshotAll(): Snapshot {
    return this.locked(() => {
      this.ensure();
      if (this.tooBig())
        throw new SnapshotError(`${this.workspace} has too many files to snapshot`);
      const dirty = this.dirtyPaths();
      const last = this.lastTree();
      if (dirty.length === 0 && last) return { tree: last };
      const maxFiles = this.opts.maxFiles ?? 100_000;
      if (!last && dirty.length > maxFiles) {
        fs.writeFileSync(path.join(this.dir, 'belayd-too-big'), String(dirty.length));
        throw new SnapshotError(
          `${this.workspace} has ${dirty.length} files, more than the ${maxFiles} belayd snapshots. Undo is off for it.`,
        );
      }
      const { kept, skipped } = this.filterBig(dirty);
      if (kept.length > 0) this.addPaths(kept);
      const tree = this.writeTree();
      return { tree, changed: dirty, ...(skipped.length > 0 ? { skipped } : {}) };
    });
  }

  /** Captures only the given workspace-relative paths (a file the agent is about to edit). */
  snapshotPaths(paths: string[]): Snapshot {
    return this.locked(() => {
      this.ensure();
      const { kept, skipped } = this.filterBig(paths);
      if (kept.length > 0) this.addPaths(kept);
      const tree = this.writeTree();
      return { tree, paths, ...(skipped.length > 0 ? { skipped } : {}) };
    });
  }

  /** What changed between two snapshots, optionally limited to some paths. */
  changes(from: string, to: string, paths?: string[]): Change[] {
    if (from === to) return [];
    const scope = paths ? ['--', ...paths] : [];
    const status = this.git([
      'diff-tree',
      '-r',
      '-z',
      '--no-renames',
      '--name-status',
      from,
      to,
      ...scope,
    ]);
    const parts = status.split('\0').filter(Boolean);
    const out: Change[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      out.push({ status: parts[i] as Change['status'], path: parts[i + 1]! });
    }
    if (out.length === 0) return out;
    const numstat = this.git([
      'diff-tree',
      '-r',
      '-z',
      '--no-renames',
      '--numstat',
      from,
      to,
      ...scope,
    ]);
    for (const entry of numstat.split('\0').filter(Boolean)) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(entry);
      const c = m && out.find((o) => o.path === m[3]);
      if (c && m) {
        if (m[1] !== '-') c.added = Number(m[1]);
        if (m[2] !== '-') c.removed = Number(m[2]);
      }
    }
    return out;
  }

  /** The blob id of a path in a snapshot, or undefined when the file did not exist. */
  blobAt(tree: string, file: string): string | undefined {
    try {
      return this.git(['rev-parse', '--verify', '-q', `${tree}:${file}`]).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The blob id the file would have right now, or undefined when it does not exist. A
   * folder in its place gets a marker that matches no snapshot, so it counts as changed.
   */
  currentBlob(file: string): string | undefined {
    if (this.beyondSymlink(file)) return undefined;
    const full = path.join(this.workspace, file);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      return undefined;
    }
    if (st.isDirectory()) return FOLDER;
    // Git stores a symlink as the text of its target. Hash the same, never follow it.
    if (st.isSymbolicLink()) {
      return this.git(['hash-object', '--stdin'], fs.readlinkSync(full)).trim();
    }
    return this.git(['hash-object', '--no-filters', '--', full]).trim();
  }

  /**
   * True when a folder on the way to `file` is a symlink. Git refuses such paths, and
   * belayd must never write or delete through one: it could lead out of the project.
   */
  beyondSymlink(file: string): boolean {
    const parts = file.split('/').slice(0, -1);
    let dir = this.workspace;
    for (const part of parts) {
      dir = path.join(dir, part);
      try {
        if (fs.lstatSync(dir).isSymbolicLink()) return true;
      } catch {
        return false; // missing: nothing to follow
      }
    }
    return false;
  }

  /**
   * Puts files back the way they were in `tree`. Files absent from `tree` are deleted.
   * Returns the files it would not touch because a folder on their path is now a symlink,
   * or because a folder now stands where a file is to be deleted.
   */
  restore(tree: string, files: string[]): string[] {
    return this.locked(() => {
      const unsafe = (f: string) => this.beyondSymlink(f) || !this.inside(f);
      const skipped = files.filter(unsafe);
      const unsafeSet = new Set(skipped);
      const safe = files.filter((f) => !unsafeSet.has(f));
      const present = safe.filter((f) => this.blobAt(tree, f));
      const presentSet = new Set(present);
      const absent = safe.filter((f) => !presentSet.has(f));
      // Deletions come first, each checked again right before it happens: a checkout
      // can turn a folder back into a symlink, and a later delete must not follow it.
      for (const f of absent) {
        const full = path.join(this.workspace, f);
        let isFolder = false;
        try {
          isFolder = fs.lstatSync(full).isDirectory();
        } catch {
          // already gone
        }
        if (isFolder || unsafe(f)) {
          skipped.push(f);
          continue;
        }
        fs.rmSync(full, { force: true });
        this.git(['update-index', '-q', '--force-remove', '--', f]);
      }
      const checkout = present.filter((f) => !unsafe(f));
      const checkoutSet = new Set(checkout);
      skipped.push(...present.filter((f) => !checkoutSet.has(f)));
      if (checkout.length > 0) {
        this.git(
          ['checkout', tree, '--pathspec-from-file=-', '--pathspec-file-nul'],
          checkout.join('\0'),
        );
      }
      // The index now matches the restored files; record it so the next snapshot does
      // not hand back the tree from before the restore.
      this.writeTree();
      return skipped;
    });
  }

  /**
   * The path's folder, resolved through any symlinks that exist, stays inside the
   * workspace. The file itself may be a link: replacing or deleting a link never
   * touches what it points to.
   */
  private inside(file: string): boolean {
    const full = path.join(this.workspace, file);
    const real = path.join(canonicalPath(path.dirname(full)), path.basename(full));
    return real.startsWith(this.workspace + path.sep);
  }

  diff(from: string, to: string, files: string[]): string {
    return this.git(['diff', '--no-color', from, to, '--', ...files]);
  }

  /** Workspace-relative form of an absolute path, or undefined when it is outside. */
  relative(abs: string): string | undefined {
    const rel = path.relative(this.workspace, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join('/');
  }

  private dirtyPaths(): string[] {
    const out = this.git([
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--no-renames',
    ]);
    const paths: string[] = [];
    for (const entry of out.split('\0')) {
      if (entry.startsWith('? ')) paths.push(entry.slice(2));
      else if (entry.startsWith('1 ')) {
        // "1 XY sub mH mI mW hH hI path": Y is the work tree compared with our index.
        const fields = entry.split(' ');
        if (fields[1]?.[1] !== '.') paths.push(fields.slice(8).join(' '));
      }
    }
    const own = this.ownData();
    return own ? paths.filter((p) => p !== own && !p.startsWith(`${own}/`)) : paths;
  }

  private filterBig(paths: string[]): { kept: string[]; skipped: string[] } {
    const max = this.opts.maxFileSize ?? 20 * 1024 * 1024;
    const kept: string[] = [];
    const skipped: string[] = [];
    for (const p of paths) {
      try {
        const st = fs.lstatSync(path.join(this.workspace, p));
        if (st.isFile() && st.size > max) {
          skipped.push(p);
          continue;
        }
      } catch {
        // deleted: still add, so the snapshot records the deletion
      }
      kept.push(p);
    }
    return { kept, skipped };
  }

  /** Records the current state of `paths`: present files are added, missing ones removed. */
  private addPaths(paths: string[]): void {
    // A file reached through a symlinked folder is not in the project any more.
    const present = paths.filter(
      (p) => !this.beyondSymlink(p) && exists(path.join(this.workspace, p)),
    );
    const presentSet = new Set(present);
    const missing = paths.filter((p) => !presentSet.has(p));
    if (present.length > 0) {
      this.git(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], present.join('\0'));
    }
    if (missing.length > 0) {
      // update-index works where git rm refuses (paths behind a symlink).
      this.git(['update-index', '-q', '--force-remove', '-z', '--stdin'], missing.join('\0'));
    }
  }

  private writeTree(): string {
    const tree = this.git(['write-tree']).trim();
    fs.writeFileSync(path.join(this.dir, 'belayd-last-tree'), tree);
    return tree;
  }

  tooBig(): boolean {
    return fs.existsSync(path.join(this.dir, 'belayd-too-big'));
  }

  private lastTree(): string | undefined {
    try {
      return fs.readFileSync(path.join(this.dir, 'belayd-last-tree'), 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Keeps the snapshots in `keep` and lets Git delete everything else. Objects younger
   * than an hour are never deleted, so a snapshot a hook has just taken survives even
   * before its audit event is written.
   */
  prune(keep: string[]): void {
    this.locked(() => {
      const wanted = new Set(keep.filter((t) => /^[0-9a-f]{40,64}$/.test(t)));
      // Only objects that still exist can be kept.
      const present = new Set(
        this.git(
          ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
          [...wanted].join('\n') + '\n',
        )
          .split('\n')
          .filter((l) => l.endsWith(' tree'))
          .map((l) => l.split(' ')[0]!),
      );
      const existing = this.git(['for-each-ref', '--format=%(refname)', 'refs/belayd-keep/'])
        .split('\n')
        .filter(Boolean);
      const lines = [
        ...existing
          .filter((r) => !present.has(r.slice('refs/belayd-keep/'.length)))
          .map((r) => `delete ${r}`),
        ...[...present].map((t) => `update refs/belayd-keep/${t} ${t}`),
      ];
      if (lines.length > 0) this.git(['update-ref', '--stdin'], `${lines.join('\n')}\n`);
      this.git([
        '-c',
        'gc.reflogExpire=now',
        '-c',
        'gc.reflogExpireUnreachable=now',
        'gc',
        '--quiet',
        '--prune=1.hour.ago',
      ]);
    });
  }

  /** Bytes the shadow repository takes on disk. */
  sizeBytes(): number {
    return dirBytes(this.dir);
  }

  emptyTree(): string {
    return EMPTY_TREE;
  }

  private git(args: string[], input?: string): string {
    try {
      return execFileSync('git', args, {
        env: this.env,
        cwd: this.workspace,
        input: input ?? '',
        maxBuffer: 256 * 1024 * 1024,
        timeout: Math.max(1000, Math.min(60_000, (this.opts.deadline ?? Infinity) - Date.now())),
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString('utf8');
    } catch (err) {
      const e = err as { stderr?: Buffer; message: string };
      throw new SnapshotError(`git ${args[0]} failed: ${e.stderr?.toString().trim() || e.message}`);
    }
  }

  private cleanEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
    return env;
  }

  /** Parallel tool calls can snapshot at the same time; Git's index allows one writer. */
  private locked<T>(fn: () => T): T {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = path.join(this.dir, 'belayd.lock');
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
        break;
      } catch {
        // A hook in a hurry gives up on the snapshot rather than on its answer.
        if (this.opts.deadline !== undefined && Date.now() > this.opts.deadline)
          throw new SnapshotError('another belayd call is still taking a snapshot');
        if (staleLock(lock) || Date.now() > deadline) {
          fs.rmSync(lock, { force: true });
          continue;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }
}

/** Exists without following a final symlink (a dangling link still exists). */
function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function dirBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p);
    else if (e.isFile()) {
      try {
        total += fs.statSync(p).size;
      } catch {
        // gone meanwhile
      }
    }
  }
  return total;
}

function staleLock(file: string): boolean {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'EPERM';
  }
}
