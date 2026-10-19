import path from 'node:path';
import { parse } from 'unbash';
import type {
  AndOr,
  Command,
  CommandArgument,
  CompoundList,
  ParsedScript,
  Pipeline,
  PipelineNode,
  Redirection,
  Statement,
  Word,
  WordPart,
} from 'unbash';

type AnyNode = PipelineNode | AndOr | CompoundList;

/**
 * Turns a shell command string into the list of programs it would run.
 *
 * The analysis is static and conservative: anything we cannot resolve is marked
 * as such (`dynamic`, `unresolved`) so policy can ask instead of guessing.
 */

export interface Redirect {
  op: string;
  target: string;
  resolved: boolean;
  /** The file descriptor written to, when given (`2> err.log`). */
  fd?: number;
}

export interface Invocation {
  argv: string[];
  /** Basename of argv[0]. Empty for a statement that is only a redirect (`> file`). */
  program: string;
  /** Source text of the command this invocation came from. */
  text: string;
  /** Working directory, or undefined when an earlier `cd` made it unknowable. */
  cwd: string | undefined;
  /** When `cwd` is undefined because branches disagree: the folders it can be. */
  cwdChoices?: string[];
  /** True when cwdChoices lists every folder it can be, not only some. */
  cwdExhaustive?: boolean;
  /** The program, or the code it runs, cannot be known statically. */
  dynamic: boolean;
  /** At least one argument could not be resolved (variables, `$(...)`, stdin from xargs). */
  unresolved: boolean;
  redirects: Redirect[];
  /** Programs that feed code to this invocation, e.g. `curl` in `curl x | sh`. */
  codeFrom: string[];
  /** Runs inline code we do not analyse (`python -c`, `node -e`). */
  inlineCode: boolean;
  /** Wrappers this invocation was found inside, e.g. `sudo`, `bash -c`, `find -exec`. */
  via: string[];
  /** Runs on another machine (`ssh host 'cmd'`). */
  remote: boolean;
  /** Text this invocation reads on stdin when statically known (heredoc, here-string, echo). */
  stdin: string | undefined;
  /** Script files this invocation runs (`bash x.sh`, `python x.py`, `./x.sh`, `source x.sh`). */
  scripts: string[];
  /** Human readable note for dynamic invocations. */
  note?: string;
  /**
   * Found inside a script that is committed to Git and unchanged, and that the agent did
   * not write in this session: your own code. What belayd cannot see there does not
   * count as a question; what it can see (`rm -rf ~`, `cat .env`) still does.
   */
  trusted?: boolean;
}

export interface ShellAnalysis {
  invocations: Invocation[];
  errors: string[];
}

export interface AnalyzeOptions {
  cwd: string;
  home: string;
  /** Environment variables the analysis may resolve. Keep this to non-secret values. */
  env?: Record<string, string>;
  /** Reads a script file so `bash x.sh` can be checked line by line. */
  /**
   * Reads a script about to run, or undefined when it cannot be read. `truncated` means
   * only the start of it was read, because it is too large to check.
   */
  readScript?: (absPath: string) => { text: string; truncated: boolean } | undefined;
  /** Whether a file exists, so a shell script that is not there yet counts as unseen code. */
  fileExists?: (absPath: string) => boolean;
  /**
   * Whether the agent wrote or changed this file earlier in the session. A Python, Node,
   * Ruby or Perl script it wrote is read like inline code before it runs.
   */
  agentWrote?: (absPath: string) => boolean;
  /** Whether a script is committed to Git, unchanged, and not written by the agent this session. */
  trustedScript?: (absPath: string) => boolean;
}

const MAX_DEPTH = 6;
const MAX_ALTERNATIVES = 64;
/** How many candidate folders or values a variable may keep after branches. */
const MAX_CHOICES = 8;
/** Limits that keep the analysis fast whatever the input; past them, belayd asks. */
const MAX_SOURCE_CHARS = 1_000_000;
const MAX_INVOCATIONS = 5_000;
const MAX_INLINE_CODE = 200_000;
const MAX_LITERAL = 10_000;
/** Marks where an unquoted expansion splits a word. The shell drops NUL bytes, so it is free. */
const FIELD_BREAK = '\u0000';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox']);
const NETWORK_FETCHERS = new Set([
  'curl',
  'wget',
  'fetch',
  'http',
  'https',
  'xh',
  'aria2c',
  'lwp-request',
  'iwr',
  'irm',
  'invoke-webrequest',
  'invoke-restmethod',
]);

/** Interpreters and the flags that make them run inline code. */
const INTERPRETERS: Record<string, { inline: string[]; module?: string[] }> = {
  python: { inline: ['-c'], module: ['-m'] },
  python2: { inline: ['-c'], module: ['-m'] },
  python3: { inline: ['-c'], module: ['-m'] },
  node: { inline: ['-e', '--eval', '-p', '--print'] },
  nodejs: { inline: ['-e', '--eval', '-p', '--print'] },
  bun: { inline: ['-e', '--eval', '-p', '--print'] },
  tsx: { inline: ['-e', '--eval', '-p', '--print'] },
  'ts-node': { inline: ['-e', '--eval', '-p', '--print'] },
  deno: { inline: ['eval'] },
  perl: { inline: ['-e', '-E'] },
  ruby: { inline: ['-e'] },
  php: { inline: ['-r'] },
  lua: { inline: ['-e'] },
  osascript: { inline: ['-e'] },
  pwsh: { inline: ['-c', '-command', '-encodedcommand', '-ec'] },
  powershell: { inline: ['-c', '-command', '-encodedcommand', '-ec'] },
};

/**
 * Tools that run a command inside a project environment: `uv run pytest`,
 * `poetry run python build.py`, `bundle exec rake`, `doppler run -- npm start`. The
 * command they start is checked like one typed directly.
 *
 * - `sub`: the subcommands that run a command (none: the tool itself does)
 * - `value`: options that take a value, before or after the subcommand
 * - `afterDashDash`: the command only comes after `--`
 * - `string`: options whose value is a shell command line
 * - `argvAfter`: options after which the rest of the words are the command
 * - `skip`: positional words to skip first (`direnv exec DIR cmd`, `aws-vault exec PROFILE cmd`)
 * - `chdir`: options that make the command run in another folder
 * - `pyFiles`: a `.py` file as the command runs with Python (`uv run build.py`)
 */
interface EnvRunner {
  sub?: string[];
  value?: string[];
  afterDashDash?: boolean;
  string?: string[];
  argvAfter?: string[];
  skip?: number;
  chdir?: string[];
  pyFiles?: boolean;
}

const CONDA: EnvRunner = {
  sub: ['run'],
  value: ['-n', '--name', '-p', '--prefix', '--cwd'],
  chdir: ['--cwd'],
};
const VERSION_MANAGER: EnvRunner = { sub: ['exec'] };
const MISE: EnvRunner = {
  sub: ['exec', 'x'],
  value: ['-C', '--cd', '-j', '--jobs'],
  string: ['-c', '--command'],
  afterDashDash: true,
  chdir: ['-C', '--cd'],
};

const ENV_RUNNERS: Record<string, EnvRunner> = {
  uv: {
    sub: ['run'],
    value: [
      '--with',
      '-w',
      '--with-editable',
      '--with-requirements',
      '--python',
      '-p',
      '--project',
      '--directory',
      '--package',
      '--extra',
      '--group',
      '--only-group',
      '--no-group',
      '--env-file',
      '--index',
      '--default-index',
      '--index-url',
      '--extra-index-url',
      '-i',
      '--find-links',
      '-f',
      '--config-file',
      '--cache-dir',
      '--color',
      '--python-preference',
      '--index-strategy',
      '--keyring-provider',
      '--resolution',
      '--prerelease',
      '--exclude-newer',
      '--link-mode',
      '--reinstall-package',
      '--upgrade-package',
      '-P',
      '--refresh-package',
      '--no-binary-package',
      '--no-build-package',
      '--allow-insecure-host',
      '--script',
      '--gui-script',
    ],
    chdir: ['--directory'],
    pyFiles: true,
  },
  poetry: { sub: ['run'], value: ['-C', '--directory', '-P', '--project'] },
  pipenv: { sub: ['run'] },
  pdm: { sub: ['run'], value: ['-p', '--project', '-G', '--group', '--venv'], pyFiles: true },
  rye: { sub: ['run'], value: ['--pyproject'] },
  hatch: { sub: ['run'], value: ['-e', '--env', '-i', '--include', '-x', '--exclude'] },
  pixi: { sub: ['run', 'exec'], value: ['-e', '--environment', '--manifest-path', '-s', '--spec'] },
  conda: CONDA,
  mamba: CONDA,
  micromamba: CONDA,
  bundle: { sub: ['exec'], value: ['--gemfile'] },
  devbox: { sub: ['run'], value: ['-c', '--config', '-e', '--env', '--env-file'] },
  asdf: VERSION_MANAGER,
  rbenv: VERSION_MANAGER,
  pyenv: VERSION_MANAGER,
  nodenv: VERSION_MANAGER,
  goenv: VERSION_MANAGER,
  mise: MISE,
  rtx: MISE,
  direnv: { sub: ['exec'], skip: 1 },
  dotenv: { value: ['-e', '-v', '-c'], afterDashDash: false },
  dotenvx: { sub: ['run'], value: ['-f', '--env-file', '-e', '--env', '--convention'] },
  op: { sub: ['run'], value: ['--env-file', '--account'] },
  doppler: {
    sub: ['run'],
    value: ['-p', '--project', '-c', '--config', '--token', '--mount', '--fallback'],
    string: ['--command'],
  },
  infisical: {
    sub: ['run'],
    value: ['--env', '--path', '--projectId', '--token', '--watch-interval', '--domain'],
    string: ['--command'],
  },
  'aws-vault': {
    sub: ['exec'],
    value: ['-d', '--duration', '-r', '--region', '-t', '--mfa-token'],
    skip: 1,
  },
  chamber: { sub: ['exec'], afterDashDash: true },
  'nix-shell': {
    afterDashDash: true,
    string: ['--run', '--command'],
    value: ['-p', '--packages', '-A', '--attr', '-I', '--arg', '--argstr'],
  },
  nix: { sub: ['develop', 'shell'], argvAfter: ['-c', '--command'] },
};

/** Options that take a value, per wrapper, so we can find where the wrapped command starts. */
const VALUE_OPTIONS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '--class', '--classdata']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  watch: new Set(['-n', '--interval', '-q', '--equexit']),
  xargs: new Set([
    '-a',
    '-d',
    '-E',
    '-I',
    '-L',
    '-n',
    '-P',
    '-s',
    '--arg-file',
    '--delimiter',
    '--max-args',
    '--max-procs',
    '--max-lines',
    '--max-chars',
    '--replace',
  ]),
  caffeinate: new Set(['-t', '-w']),
  flock: new Set(['-w', '--timeout', '-E', '--conflict-exit-code']),
  exec: new Set(['-a']),
  npx: new Set(['-p', '--package']),
  ssh: new Set([
    '-p',
    '-i',
    '-l',
    '-o',
    '-F',
    '-J',
    '-L',
    '-R',
    '-D',
    '-b',
    '-c',
    '-E',
    '-e',
    '-I',
    '-m',
    '-O',
    '-Q',
    '-S',
    '-W',
    '-w',
    '-B',
  ]),
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']),
  arch: new Set(['-e', '-d', '-arch']),
  xcrun: new Set(['--sdk', '--toolchain', '-sdk', '-toolchain']),
  'systemd-run': new Set([
    '-p',
    '--property',
    '-u',
    '--unit',
    '-E',
    '--setenv',
    '-M',
    '--machine',
    '-H',
    '--host',
    '--description',
    '--slice',
    '--working-directory',
    '--uid',
    '--gid',
  ]),
  nsenter: new Set(['-t', '--target', '-S', '--setuid', '-G', '--setgid', '-r', '-w']),
  chroot: new Set(['--userspec', '--groups']),
  script: new Set([
    '-F',
    '-t',
    '-T',
    '-I',
    '-O',
    '-B',
    '-E',
    '-m',
    '--timing',
    '--log-in',
    '--log-out',
    '--log-io',
    '--log-timing',
    '--echo',
    '--logging-format',
  ]),
  parallel: new Set(['-j', '--jobs', '-S', '--sshlogin', '--joblog', '-a', '--arg-file', '-d']),
};

/** Wrappers that simply run the rest of their arguments as a command. */
const PASSTHROUGH = new Set([
  'sudo',
  'doas',
  'nohup',
  'nice',
  'ionice',
  'timeout',
  'stdbuf',
  'command',
  'builtin',
  'exec',
  'time',
  'caffeinate',
  'unbuffer',
  'chronic',
  'setsid',
  'arch',
  'xcrun',
  'chroot',
  'pkexec',
  'run0',
  'systemd-run',
  'unshare',
  'nsenter',
  'firejail',
]);
const AWKS = new Set(['awk', 'gawk', 'mawk', 'nawk']);
/** Functions bash and zsh call on their own, without the command naming them. */
const HOOK_FUNCTIONS = new Set([
  'command_not_found_handle',
  'command_not_found_handler',
  'precmd',
  'preexec',
  'chpwd',
  'periodic',
  'zshexit',
  'zshaddhistory',
]);
/**
 * Environment variables that point at where tools are installed. A program path built
 * from one of them (`"$JAVA_HOME/bin/java"`) is judged by its name. Shell-set variables
 * like `$_` or `$REPLY` are never on this list: the command itself controls those.
 */
const ENV_ROOTS = new Set([
  'JAVA_HOME',
  'JDK_HOME',
  'JRE_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'ANDROID_NDK_HOME',
  'GRADLE_HOME',
  'GRADLE_USER_HOME',
  'MAVEN_HOME',
  'M2_HOME',
  'GOROOT',
  'GOPATH',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'PYENV_ROOT',
  'NVM_DIR',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'HOMEBREW_PREFIX',
  'SDKMAN_DIR',
  'ASDF_DIR',
  'DOTNET_ROOT',
  'FLUTTER_ROOT',
  'PNPM_HOME',
  'BUN_INSTALL',
  'DENO_INSTALL',
  'VOLTA_HOME',
]);
/** Programs that cannot write files, so a venv's activate script is still the one it wrote. */
const KEEPS_GENERATED = new Set([
  'cd',
  'pushd',
  'popd',
  'source',
  '.',
  'echo',
  'printf',
  'true',
  ':',
  'test',
  '[',
  'pwd',
  'ls',
  'which',
]);
/**
 * tmux commands whose arguments are a shell command, or keys typed into a shell, with
 * the option letters that take a value for each.
 */
const TMUX_RUNS: Record<string, string> = {
  new: 'cefFnstxy',
  'new-session': 'cefFnstxy',
  'new-window': 'ceFnt',
  neww: 'ceFnt',
  'split-window': 'ceFlt',
  splitw: 'ceFlt',
  'run-shell': 'cdt',
  run: 'cdt',
  'respawn-pane': 'cet',
  respawnp: 'cet',
  'respawn-window': 'cet',
  respawnw: 'cet',
  'send-keys': 'Nt',
  send: 'Nt',
  'pipe-pane': 't',
  pipep: 't',
  'display-popup': 'bcdehsStTwxy',
  popup: 'bcdehsStTwxy',
};
/** tmux commands that run other tmux commands, which may in turn run shell commands. */
const TMUX_DYNAMIC = new Set([
  'if-shell',
  'if',
  'command-prompt',
  'confirm-before',
  'confirm',
  'set-hook',
  'bind-key',
  'bind',
  'source-file',
  'source',
  'display-menu',
  'menu',
]);

const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx']);
/** Packages whose command has another name: `npx belayd-cli approve` runs `belayd approve`. */
const PACKAGE_COMMANDS = new Map([['belayd-cli', 'belayd']]);

interface EvalWord {
  text: string;
  value: string;
  values: string[];
  resolved: boolean;
  /** Programs run inside `$(...)` or `<(...)` within this word. */
  subPrograms: string[];
  /** For a word that is just `<(cmd)`: what cmd prints, when that is known. */
  substituted?: string;
  /**
   * Set when an unquoted expansion split this word into several (`X="rm -rf"; $X ~`),
   * or removed it (an empty `$X`): one list of words per alternative in `values`.
   */
  fields?: string[][];
  /** Unknown only because of environment variables (`$JAVA_HOME/bin/java`). */
  envOnly?: boolean;
  /**
   * Known values a branch may have left in a variable this word uses, as the words
   * each would give. The word itself stays unknown; these are only checked on the side.
   */
  candidates?: string[][];
  /** True when `candidates` are all the values this word can have. */
  exhaustive?: boolean;
}

interface Scope {
  vars: Map<string, string | null>;
  cwd: string | undefined;
  aliases: Map<string, string>;
  /** Files written by network fetchers in this script (`curl -o x.sh`). */
  downloads: Map<string, string>;
  /** Files written earlier in this same command (`echo ... > x.sh`). */
  written: Set<string>;
  /**
   * What some of those files hold, when it is known exactly (`cat > x.py <<'EOF'`), so a
   * script written and run in one command can be read. Shared like `written`: two writes
   * that may leave different text (branches, appends, copies) make it null, unknown.
   */
  contents: Map<string, string | null>;
  /** `$1`, `$2`, `"$@"` inside a script, when its arguments are known. */
  positional?: string[];
  /** Scripts that a trusted tool creates earlier in this command (`python -m venv`). */
  generated: Set<string>;
  /** Functions defined so far, checked again at each call with that call's arguments. */
  functions: Map<string, FunctionDef[]>;
  /** When `cwd` is undefined because branches disagree: the folders it can be. */
  cwdChoices?: string[];
  /** True when cwdChoices lists every folder it can be, not only some. */
  cwdExhaustive?: boolean;
  /** Variables that branches left holding one of a few known values. */
  choices: Map<string, string[]>;
  /** Variables in `choices` whose list is complete: every path left a known value. */
  exhaustive: Set<string>;
  /**
   * Variables whose value is unknown but which certainly name this program, like
   * JAVACMD in gradlew: `$JAVA_HOME/bin/java` in one branch and `java` in the other.
   */
  programs: Map<string, string>;
}

/** A function body. Branches can leave several definitions of one name. */
interface FunctionDef {
  body: AnyNode;
  src: string;
}

interface Ctx {
  depth: number;
  via: string[];
  remote: boolean;
  /** Scripts being read further up (path and arguments), so a script that runs itself is read once. */
  scripts?: readonly string[];
  /** Functions being checked further up, so a recursive function is checked once. */
  functions?: readonly string[];
  /** Inside a committed, unchanged script (see Invocation.trusted). */
  trusted?: boolean;
}

interface StdinInfo {
  producers: string[];
  text: string | undefined;
}

interface StageResult {
  programs: string[];
  stdout: string | undefined;
}

export function analyzeShell(command: string, opts: AnalyzeOptions): ShellAnalysis {
  const analyzer = new Analyzer(opts);
  const scope: Scope = {
    vars: new Map(Object.entries({ HOME: opts.home, ...opts.env })),
    cwd: opts.cwd,
    aliases: new Map(),
    downloads: new Map(),
    written: new Set(),
    contents: new Map(),
    generated: new Set(),
    functions: new Map(),
    programs: new Map(),
    choices: new Map(),
    exhaustive: new Set(),
  };
  analyzer.source(command, scope, { depth: 0, via: [], remote: false }, undefined);
  analyzer.finishTraps();
  return { invocations: analyzer.out, errors: analyzer.errors };
}

export function programName(word: string): string {
  let name = path.posix.basename(word);
  if (process.platform === 'win32' && name.toLowerCase().endsWith('.exe')) name = name.slice(0, -4);
  // macOS and Windows file systems are case-insensitive by default: `RM` runs rm.
  if (process.platform === 'darwin' || process.platform === 'win32') name = name.toLowerCase();
  return name;
}

class Analyzer {
  out: Invocation[] = [];
  errors: string[] = [];

  constructor(private readonly opts: AnalyzeOptions) {}

  /** Characters left to parse. Scripts that run each other many times over stop here. */
  private budget = MAX_SOURCE_CHARS;
  private readonly parsed = new Map<string, ParsedScript>();
  /** States at `break`/`continue` in the loops, and `return` in the functions, being read. */
  private readonly loopExits: Scope[][] = [];
  private readonly returns: Scope[][] = [];
  /** Trap code, checked again once the whole command has been read. */
  readonly traps: { code: EvalWord; text: string; scope: Scope; ctx: Ctx }[] = [];
  /** Environment roots the analysed code names as a variable to set, read or export. */
  private readonly touched = new Set<string>();
  private ifsMentioned = false;
  private exhausted = false;

  source(src: string, scope: Scope, ctx: Ctx, stdin: StdinInfo | undefined): void {
    if (ctx.depth > MAX_DEPTH) {
      this.pushDynamic(src, scope, ctx, 'nested too deeply to analyse');
      return;
    }
    this.budget -= src.length + 16;
    if (src.includes('IFS')) this.ifsMentioned = true;
    for (const name of ENV_ROOTS) {
      if (!src.includes(name) || this.touched.has(name)) continue;
      // Any mention other than `$NAME` or `${NAME}` may set it: `NAME=`, `read NAME`,
      // `printf -v NAME`, `export NAME`, `${NAME:=x}`.
      const bare = new RegExp(`(?<![\\w$])(?<!\\$\\{)${name}(?!\\w)|\\$\\{${name}:?=`);
      if (bare.test(src)) this.touched.add(name);
    }
    if (this.budget < 0) this.exhaust(this.base(src.slice(0, 200), scope, ctx));
    if (this.exhausted) return;
    let ast = this.parsed.get(src);
    if (!ast) {
      ast = parse(src);
      if (src.length > 512) this.parsed.set(src, ast);
    }
    // A parse error inside your own committed script is not a reason to ask about it.
    if (!ctx.trusted) for (const err of ast.errors ?? []) this.errors.push(err.message);
    this.script(ast, ast.source ?? src, scope, ctx, stdin);
  }

  private script(
    ast: ParsedScript,
    src: string,
    scope: Scope,
    ctx: Ctx,
    stdin: StdinInfo | undefined,
  ): void {
    this.statements(ast.commands, ast.source ?? src, scope, ctx, stdin);
  }

  private statements(
    list: readonly Statement[],
    src: string,
    scope: Scope,
    ctx: Ctx,
    stdin?: StdinInfo,
  ): void {
    for (const st of list) {
      if (this.exhausted) return;
      // `cmd &` runs in a background subshell: what it changes stays there.
      this.node(st.command, src, st.background ? cloneScope(scope) : scope, ctx, stdin);
    }
  }

  private compoundList(list: CompoundList, src: string, scope: Scope, ctx: Ctx): void {
    this.statements(list.commands, src, scope, ctx);
  }

  /** Returns information about what the node writes to stdout, for pipelines. */
  private node(n: AnyNode, src: string, scope: Scope, ctx: Ctx, stdin?: StdinInfo): StageResult {
    const before = this.out.length;
    let stdout: string | undefined;
    switch (n.type) {
      case 'AndOr': {
        // Each command after the first runs only if the ones before went a certain way.
        // Inside the list, state flows on; after it, the list may have stopped anywhere.
        const work = cloneScope(scope);
        const exits: Scope[] = [];
        n.commands.forEach((c, i) => {
          this.node(c, src, work, ctx);
          if (i < n.commands.length - 1) exits.push(cloneScope(work));
        });
        this.merge(scope, [...exits, work]);
        break;
      }
      case 'Pipeline':
        stdout = this.pipeline(n, src, scope, ctx);
        break;
      case 'Time':
      case 'Negation':
        if (n.command) stdout = this.node(n.command, src, scope, ctx, stdin).stdout;
        break;
      case 'Command':
        stdout = this.command(n, src, scope, ctx, stdin);
        break;
      case 'Subshell':
        this.compoundList(n.body, src, cloneScope(scope), ctx);
        break;
      case 'BraceGroup':
        this.compoundList(n.body, src, scope, ctx);
        break;
      case 'CompoundList':
        this.compoundList(n, src, scope, ctx);
        break;
      case 'If': {
        this.compoundList(n.clause, src, scope, ctx);
        const yes = cloneScope(scope);
        const no = cloneScope(scope);
        this.compoundList(n.then, src, yes, ctx);
        if (n.else) this.node(n.else, src, no, ctx);
        this.merge(scope, [yes, no]);
        break;
      }
      case 'For':
      case 'Select': {
        for (const w of n.wordlist ?? []) this.evalWord(w, src, scope, ctx);
        // The body runs any number of times, maybe none.
        this.loop(scope, (body) => {
          this.forget(body, n.name.value);
          this.compoundList(n.body, src, body, ctx);
        });
        break;
      }
      case 'ArithmeticFor': {
        this.substitutionsIn([n.initialize, n.test, n.update], src, scope, ctx);
        this.loop(scope, (body) => this.compoundList(n.body, src, body, ctx));
        break;
      }
      case 'While': {
        this.compoundList(n.clause, src, scope, ctx);
        this.loop(scope, (body) => {
          this.compoundList(n.body, src, body, ctx);
          this.compoundList(n.clause, src, body, ctx);
        });
        break;
      }
      case 'Case': {
        this.evalWord(n.word, src, scope, ctx);
        // Unless an arm matches anything (`*)`), maybe no pattern matched at all.
        const catchAll = n.items.some((item) => item.pattern.some((w) => w.text === '*'));
        const outcomes = catchAll ? [] : [cloneScope(scope)];
        let carried: Scope | undefined;
        for (const item of n.items) {
          // An arm is entered by matching, or by falling through from the one before
          // (`;&`, `;;&`), which brings that arm's changes along.
          const arm = cloneScope(scope);
          if (carried) this.merge(arm, [cloneScope(scope), carried]);
          this.compoundList(item.body, src, arm, ctx);
          outcomes.push(arm);
          carried = item.terminator === ';&' || item.terminator === ';;&' ? arm : undefined;
        }
        this.merge(scope, outcomes);
        break;
      }
      case 'TestCommand':
      case 'ArithmeticCommand':
        this.substitutionsIn([n.expression], src, scope, ctx);
        break;
      case 'Redirected': {
        this.node(n.command, src, scope, ctx, stdin);
        const redirects = this.redirects(n.redirects, src, scope, ctx).redirects;
        if (redirects.length > 0) {
          this.push({
            ...this.base(src.slice(n.pos, n.end), scope, ctx),
            redirects,
          });
        }
        break;
      }
      case 'Function': {
        // Defining a function runs nothing. Its body is checked at each call, with the
        // arguments and state of that call. Hook functions the shell itself calls
        // (when a command is not found, before each prompt) are checked right away.
        const name = n.name.value ?? n.name.text;
        scope.functions.set(name, [{ body: n.body, src }]);
        if (HOOK_FUNCTIONS.has(name) || /^TRAP[A-Z]+$/.test(name)) {
          const inner = cloneScope(scope);
          delete inner.positional;
          this.node(n.body, src, inner, { ...ctx, functions: [...(ctx.functions ?? []), name] });
        }
        break;
      }
      case 'Coproc':
        this.node(n.body, src, cloneScope(scope), ctx);
        break;
      default:
        break;
    }
    const programs = this.out
      .slice(before)
      .map((i) => i.program)
      .filter(Boolean);
    return { programs, stdout };
  }

  private pipeline(p: Pipeline, src: string, scope: Scope, ctx: Ctx): string | undefined {
    const producers: string[] = [];
    let previous: string | undefined;
    let last: Scope | undefined;
    for (const stage of p.commands) {
      // In bash every stage runs in its own subshell. zsh runs the last one in the
      // current shell, so what it changes may stay (`true | cd ~`).
      last = cloneScope(scope);
      const result = this.node(stage, src, last, ctx, {
        producers: [...producers],
        text: previous,
      });
      producers.push(...result.programs);
      previous = result.stdout;
    }
    if (last && p.commands.length > 1) this.merge(scope, [cloneScope(scope), last]);
    return previous;
  }

  private command(
    cmd: Command,
    src: string,
    scope: Scope,
    ctx: Ctx,
    stdin: StdinInfo | undefined,
  ): string | undefined {
    const text = src.slice(cmd.pos, cmd.end);
    const words: EvalWord[] = [];
    // The words as written, kept to check the known values branches may have left.
    const slots: EvalWord[][] = [];
    const add = (w: EvalWord, expanded: EvalWord[]) => {
      words.push(...expanded);
      slots.push(w.candidates ? [w] : expanded);
    };
    if (cmd.name) {
      const name = this.evalWord(cmd.name, src, scope, ctx);
      add(name, expandWord(name));
    }
    const assignments: { name: string; value: EvalWord }[] = [];
    for (const arg of cmd.args) {
      if (arg.type === 'Word') {
        const w = this.evalWord(arg, src, scope, ctx);
        add(w, expandWord(w));
      } else {
        const value = this.evalAssignment(arg, src, scope, ctx);
        const w = { ...value, value: `${arg.name}=${value.value}`, text: arg.text };
        delete w.candidates;
        add(w, [w]);
        assignments.push({ name: arg.name, value });
      }
    }
    // Prefix assignments (`X=1 cmd`) only affect the command's environment,
    // but they can still hide substitutions that run.
    const prefixAssignments: { name: string; value: EvalWord }[] = [];
    for (const p of cmd.prefix) {
      if (p.type === 'Assignment')
        prefixAssignments.push({ name: p.name, value: this.evalAssignment(p, src, scope, ctx) });
    }
    const { redirects, inline, exact } = this.redirects(cmd.redirects, src, scope, ctx);
    for (const a of prefixAssignments) {
      if (!a.value.resolved) continue;
      if (a.name === 'PROMPT_COMMAND') {
        this.codeString(
          [a.value],
          text,
          scope,
          { ...ctx, depth: ctx.depth + 1, via: [...ctx.via, 'PROMPT_COMMAND'] },
          undefined,
        );
      } else if (a.name === 'BASH_ENV' || a.name === 'ENV') {
        const holder = this.base(text, scope, ctx);
        this.runScript(holder, a.value, scope, { ...ctx, via: [...ctx.via, a.name] }, false, true);
        if (holder.dynamic) this.push({ ...holder, program: '', dynamic: true });
      }
    }

    if (words.length === 0) {
      // A bare assignment (`X=rm`) updates the scope. A bare redirect truncates a file.
      for (const a of prefixAssignments) this.assign(scope, a.name, a.value);
      if (redirects.length > 0) this.push({ ...this.base(text, scope, ctx), redirects });
      return undefined;
    }

    const effectiveStdin: StdinInfo | undefined =
      inline !== undefined ? { producers: [], text: inline } : stdin;
    // Words that use a variable a branch left as one of a few known values.
    const chosen = slots.flat().filter((w) => w.candidates);
    if (chosen.length > 0) {
      const { combos, complete } = probes(slots);
      if (complete && chosen.every((w) => w.exhaustive)) {
        // Every value is known: the command is one of these, each checked in full, and
        // what it changes is what they agree on.
        const outcomes = combos.map((probe) => {
          const run = cloneScope(scope);
          const ran = this.invoke(probe, text, run, ctx, effectiveStdin, redirects);
          this.trackWrites(ran, probe, redirects, run);
          this.afterCommand(ran, probe, assignments, run);
          return run;
        });
        this.merge(scope, outcomes);
        return undefined;
      }
      // Otherwise the words are unknown below. Each combination of the known values is
      // also checked on a copy that is then dropped: it can only add findings (`rm -rf
      // "$X"` where X may be ~), never remove one.
      for (const probe of combos)
        this.invoke(probe, text, cloneScope(scope), ctx, effectiveStdin, redirects);
    }
    const program = this.invoke(words, text, scope, ctx, effectiveStdin, redirects);
    this.trackWrites(program, words, redirects, scope);

    this.afterCommand(program, words, assignments, scope);
    const tmpdirChanged =
      prefixAssignments.some((a) => a.name === 'TMPDIR') ||
      scope.vars.get('TMPDIR') !== this.opts.env?.TMPDIR;
    const out = this.staticStdout(program, words, effectiveStdin, tmpdirChanged);
    this.recordContents(
      program,
      words,
      redirects,
      inline === undefined || exact ? out : undefined,
      scope,
    );
    return out;
  }

  /** Remembers what a command wrote to files, when that is known exactly. */
  private recordContents(
    program: string,
    words: EvalWord[],
    redirects: Redirect[],
    out: string | undefined,
    scope: Scope,
  ): void {
    const set = (p: string, value: string | null) => {
      const abs = resolveIn(scope.cwd, p, this.opts.home);
      if (!abs) return;
      const same = !scope.contents.has(abs) || scope.contents.get(abs) === value;
      scope.contents.set(abs, same ? value : null);
    };
    for (const r of redirects) {
      if (!r.op.includes('>') || !r.resolved) continue;
      const stdout = (r.op === '>' || r.op === '>|') && (r.fd === undefined || r.fd === 1);
      set(r.target, stdout && out !== undefined ? out : null);
    }
    if (program === 'tee') {
      const args = words.slice(1);
      const append = args.some((w) => w.value === '--append' || /^-[a-z]*a/.test(w.value));
      for (const w of args)
        if (w.resolved && !w.value.startsWith('-'))
          set(w.value, !append && out !== undefined ? out : null);
    }
    if (['cp', 'mv', 'install', 'ln'].includes(program)) {
      const args = words.slice(1).filter((w) => w.resolved && !w.value.startsWith('-'));
      if (args.length > 1) set(args[args.length - 1]!.value, null);
    }
  }

  /**
   * Tracks state that later commands depend on. A function of the same name runs
   * instead of the builtin (`cd() { ...; }; cd /tmp`), unless its definition was
   * conditional, so both outcomes are kept.
   */
  private afterCommand(
    program: string,
    words: EvalWord[],
    assignments: { name: string; value: EvalWord }[],
    scope: Scope,
  ): void {
    // `builtin cd x` and `command cd x` are cd itself, and skip any function named cd.
    if ((program === 'builtin' || program === 'command') && words.length > 1) {
      const rest = words.slice(1).filter((w, i) => i > 0 || !/^-[pvV]+$/.test(w.value));
      if (rest[0] && !rest[0].value.startsWith('-'))
        return this.trackState(programName(rest[0].value), rest, assignments, scope);
    }
    if (words[0] && scope.functions.has(words[0].value)) {
      const builtin = cloneScope(scope);
      this.trackState(program, words, assignments, builtin);
      this.merge(scope, [cloneScope(scope), builtin]);
    } else this.trackState(program, words, assignments, scope);
  }

  /** What builtins like cd, export, read and alias change for the commands after them. */
  private trackState(
    program: string,
    words: EvalWord[],
    assignments: { name: string; value: EvalWord }[],
    scope: Scope,
  ): void {
    switch (program) {
      case 'cd':
      case 'pushd': {
        const target = words.slice(1).find((w) => !w.value.startsWith('-'));
        const from = folders(scope);
        const candidates = (target?.candidates ?? []).map((fields) => fields.join(' '));
        const targets: (string | undefined)[] = !target
          ? [this.opts.home]
          : target.resolved
            ? [target.value]
            : // Unknown, or one of a few known candidates.
              [...(target.exhaustive ? [] : [undefined]), ...candidates];
        this.setCwd(
          scope,
          targets.flatMap((t) =>
            t === undefined ? [undefined] : from.map((f) => resolveIn(f, t, this.opts.home)),
          ),
        );
        break;
      }
      case 'popd':
        this.setCwd(scope, [undefined]);
        break;
      case 'export':
      case 'declare':
      case 'typeset':
      case 'local':
      case 'readonly':
        for (const a of assignments) this.assign(scope, a.name, a.value);
        break;
      case 'shift': {
        // `shift` and `shift 2` move the arguments along; anything else makes them unknown.
        // Shifting past the end fails and leaves them as they were.
        const n = words[1] ? words[1].value : '1';
        if (!scope.positional) break;
        if ((words[1]?.resolved ?? true) && /^\d+$/.test(n)) {
          if (Number(n) <= scope.positional.length)
            scope.positional = scope.positional.slice(Number(n));
        } else delete scope.positional;
        break;
      }
      case 'set': {
        // Like bash: option words come first (one containing `o` takes the next word as
        // an option name), and the arguments start at the first other word, `--` or `-`.
        const rest = words.slice(1);
        let start: number | undefined;
        for (let i = 0; i < rest.length; i++) {
          const w = rest[i]!;
          if (!w.resolved) {
            start = -1;
            break;
          }
          if (w.value === '--' || w.value === '-') {
            // A lone `-` with nothing after it keeps the arguments in bash and clears
            // them in zsh.
            start = w.value === '-' && i === rest.length - 1 ? -1 : i + 1;
            break;
          }
          if (/^[-+]./.test(w.value)) {
            if (w.value.slice(1).includes('o')) i++;
            continue;
          }
          start = i;
          break;
        }
        if (start === undefined) break; // only options: the arguments stay
        const values = start < 0 ? [] : rest.slice(start);
        if (start >= 0 && values.every((w) => w.resolved))
          scope.positional = values.map((w) => w.value);
        else delete scope.positional;
        break;
      }
      case 'unset': {
        const functions = words.some((w) => w.value === '-f');
        for (const w of words.slice(1)) {
          if (w.value.startsWith('-')) continue;
          if (functions) scope.functions.delete(w.value);
          else {
            scope.vars.delete(w.value);
            scope.programs.delete(w.value);
            scope.choices.delete(w.value);
            scope.exhaustive.delete(w.value);
          }
        }
        break;
      }
      case 'read':
      case 'mapfile':
      case 'readarray':
        for (const w of words.slice(1)) if (!w.value.startsWith('-')) this.forget(scope, w.value);
        break;
      case 'printf': {
        // `printf -v NAME ...` sets NAME.
        const v = words.findIndex((w) => w.value === '-v');
        if (v >= 0 && words[v + 1]) this.forget(scope, words[v + 1]!.value);
        break;
      }
      case 'getopts':
        delete scope.positional;
        if (words[2]) this.forget(scope, words[2].value);
        break;
      case 'break':
      case 'continue':
        this.loopExits.at(-1)?.push(cloneScope(scope));
        break;
      case 'return':
        this.returns.at(-1)?.push(cloneScope(scope));
        break;
      case 'alias':
        for (const a of assignments) if (a.value.resolved) scope.aliases.set(a.name, a.value.value);
        for (const w of words.slice(1)) {
          const m = /^([^=\s]+)=(.*)$/s.exec(w.value);
          if (m && w.resolved) scope.aliases.set(m[1]!, m[2]!);
        }
        break;
    }
  }

  /**
   * Records one invocation and unwraps wrappers (`sudo`, `env`, `bash -c`, `find -exec`, ...)
   * into further invocations. Returns the program name of the outermost invocation.
   */
  private invoke(
    words: EvalWord[],
    text: string,
    scope: Scope,
    ctx: Ctx,
    stdin: StdinInfo | undefined,
    redirects: Redirect[],
  ): string {
    const head = words[0]!;
    const args = words.slice(1);
    const base = this.base(text, scope, ctx);
    // `"$JAVA_HOME/bin/java"` runs java, wherever the user's environment points.
    const known = this.programOf(head, scope);
    if (!head.resolved && !known) {
      this.push({
        ...base,
        argv: words.map((w) => w.value),
        dynamic: true,
        unresolved: true,
        redirects,
        codeFrom: head.subPrograms,
        note: `the command name \`${head.text}\` is only known at run time`,
      });
      return '';
    }

    // In zsh, the default shell on macOS, `=rm` expands to the path of rm.
    const program =
      known ??
      programName(
        head.text.startsWith('=') && head.value.length > 1 ? head.value.slice(1) : head.value,
      );

    // Any other program could rewrite a generated activate script before it is sourced.
    if (!KEEPS_GENERATED.has(program)) scope.generated.clear();

    const alias = scope.aliases.get(head.value);
    if (alias !== undefined && ctx.depth < MAX_DEPTH) {
      const rest = args.map((w) => quote(w.value)).join(' ');
      this.source(
        `${alias} ${rest}`,
        scope,
        { ...ctx, depth: ctx.depth + 1, via: [...ctx.via, 'alias'] },
        stdin,
      );
      return program;
    }

    const inv: Invocation = {
      ...base,
      argv: words.map((w) => w.value),
      program,
      unresolved: args.some((w) => !w.resolved),
      redirects,
      stdin: stdin?.text,
    };

    // A function call runs the function's body, in this shell, with its own arguments.
    // The call is then also checked as the command it names, so a function called
    // `bash` or `eval` cannot hide what `command bash -c ...` would run.
    const defs = scope.functions.get(head.value);
    // A recursive call is already being checked; one nested too deeply is not followed.
    if (defs && !ctx.functions?.includes(head.value) && ctx.depth >= MAX_DEPTH) {
      inv.dynamic = true;
      inv.note = `calls ${head.value}, nested too deeply to check`;
    }
    if (defs && !ctx.functions?.includes(head.value) && ctx.depth < MAX_DEPTH) {
      const callerArgs = scope.positional;
      const inner: Ctx = {
        ...ctx,
        depth: ctx.depth + 1,
        via: [...ctx.via, `${head.value}()`],
        functions: [...(ctx.functions ?? []), head.value],
      };
      // Every definition a branch may have left is checked, each from the call's state.
      const outcomes = defs.map((def) => {
        this.budget -= def.body.end - def.body.pos + 16;
        if (this.budget < 0) this.exhaust(base);
        const run = defs.length === 1 ? scope : cloneScope(scope);
        if (args.every((w) => w.resolved)) run.positional = args.map((w) => w.value);
        else delete run.positional;
        this.returns.push([]);
        this.node(def.body, def.src, run, inner);
        // `return` leaves the body early, with the state it had there.
        const early = this.returns.pop()!;
        if (early.length > 0) this.merge(run, [cloneScope(run), ...early]);
        return run;
      });
      if (defs.length > 1) this.merge(scope, outcomes);
      if (callerArgs) scope.positional = callerArgs;
      else delete scope.positional;
    }
    let directScript: EvalWord | undefined;
    if (head.value.includes('/')) {
      const executed = resolveIn(scope.cwd, head.value, this.opts.home);
      const downloader = executed ? scope.downloads.get(executed) : undefined;
      if (downloader) inv.codeFrom = [downloader];
      directScript = head;
    }
    this.push(inv);
    if (directScript) this.runScript(inv, directScript, scope, ctx, false, 'shebang', args);
    this.trackDownloads(program, args, redirects, scope);

    const nested = (via: string): Ctx => ({ ...ctx, depth: ctx.depth + 1, via: [...ctx.via, via] });

    if (PASSTHROUGH.has(program)) {
      if (program === 'command' && args.some((w) => w.value === '-v' || w.value === '-V'))
        return program;
      let rest = skipOptions(args, VALUE_OPTIONS[program]);
      if (program === 'timeout' || program === 'chroot') rest = rest.slice(1); // duration, root
      const inner = program === 'sudo' ? this.withChdir(args, ['-D', '--chdir'], scope) : scope;
      if (rest.length > 0) this.invoke(rest, text, inner, nested(program), stdin, []);
      return program;
    }

    // Only `uv run`, not `uv venv`: other subcommands go on to the checks below.
    const runner = ENV_RUNNERS[program];
    if (runner && this.envRunner(program, runner, args, text, scope, stdin, nested)) return program;

    switch (program) {
      case 'env': {
        const rest: EvalWord[] = [];
        let i = 0;
        for (; i < args.length; i++) {
          const w = args[i]!;
          if (w.value === '-S' || w.value === '--split-string') {
            const code = args[i + 1];
            if (code?.resolved) this.source(code.value, scope, nested('env -S'), stdin);
            return program;
          }
          if (w.value.startsWith('--split-string=')) {
            this.source(w.value.slice('--split-string='.length), scope, nested('env -S'), stdin);
            return program;
          }
          if (VALUE_OPTIONS.env!.has(w.value)) {
            i++;
            continue;
          }
          if (w.value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value)) continue;
          break;
        }
        rest.push(...args.slice(i));
        const inner = this.withChdir(args.slice(0, i), ['-C', '--chdir'], scope);
        if (rest.length > 0) this.invoke(rest, text, inner, nested('env'), stdin, []);
        return program;
      }
      case 'busybox':
      case 'toybox': {
        // `busybox rm -rf ~` runs the rm applet.
        if (args.length > 0 && !args[0]!.value.startsWith('-')) {
          this.invoke(args, text, scope, nested(program), stdin, []);
        }
        return program;
      }
      case 'trap': {
        // `trap 'rm -rf ~' EXIT` runs its first argument as code later.
        const code = args.find((w) => !w.value.startsWith('-'));
        if (code && args.length > 1) {
          this.codeString([code], text, scope, nested('trap'), undefined);
          // It runs later (at exit, on an error), when functions defined after the
          // trap exist too, so it is checked again at the end.
          this.traps.push({ code, text, scope, ctx: nested('trap') });
        }
        return program;
      }
      case 'xargs': {
        const rest = skipOptions(args, VALUE_OPTIONS.xargs);
        // With -I, each item replaces the placeholder instead of going at the end.
        let placeholder: string | undefined;
        args.forEach((w, k) => {
          if (w.value === '-I') placeholder = args[k + 1]?.value;
          else if (w.value === '-i' || w.value === '--replace') placeholder = '{}';
          else if (w.value.startsWith('--replace=')) placeholder = w.value.slice(10);
          else if (/^-I./.test(w.value)) placeholder = w.value.slice(2);
        });
        const inner = (rest.length > 0 ? rest : [literal('echo')]).map((w) =>
          placeholder && w.value.includes(placeholder) ? unknownWord(w.value) : w,
        );
        this.invoke(
          placeholder ? inner : [...inner, unknownWord('<items from stdin>')],
          text,
          scope,
          nested('xargs'),
          undefined,
          [],
        );
        return program;
      }
      case 'find':
        this.find(args, text, scope, nested('find'));
        return program;
      case 'script': {
        // util-linux: `script -c 'cmd' file`. BSD and macOS: `script [-q] file cmd args...`.
        const c = args.findIndex((w) => w.value === '-c' || w.value === '--command');
        if (c >= 0) {
          this.codeString(args.slice(c + 1, c + 2), text, scope, nested('script -c'), undefined);
          return program;
        }
        const rest = skipOptions(args, VALUE_OPTIONS.script).slice(1);
        if (rest.length > 0) this.invoke(rest, text, scope, nested('script'), stdin, []);
        return program;
      }
      case 'tmux': {
        // tmux's own options come first; `-c cmd` among them runs cmd in a shell.
        let first = 0;
        for (; first < args.length; first++) {
          const v = args[first]!.value;
          if (!v.startsWith('-') || v === '-') break;
          if (v === '--') {
            first++;
            break;
          }
          const at = v.slice(1).search(/[cfLST]/);
          if (at < 0) continue;
          const letter = v[at + 1]!;
          const attached = v.slice(at + 2);
          const value = attached ? { ...args[first]!, value: attached } : args[++first];
          if (letter === 'c' && value) {
            this.codeString([value], text, scope, nested('tmux -c'), undefined);
            return program;
          }
        }
        // `tmux new -d 'rm -rf ~'`, `tmux send-keys 'rm -rf ~' Enter`, also after `;`.
        for (let i = first; i < args.length; i++) {
          const sub = args[i]!.value;
          if (TMUX_DYNAMIC.has(sub)) {
            inv.dynamic = true;
            inv.note = `tmux ${sub} runs tmux commands that belayd does not follow`;
            continue;
          }
          const valueLetters = TMUX_RUNS[sub];
          if (valueLetters === undefined) continue;
          let end = i + 1;
          while (end < args.length && args[end]!.value !== ';') end++;
          const words = getoptPositionals(args.slice(i + 1, end), valueLetters).filter(
            (w) => !/^(Enter|C-m|KPEnter)$/.test(w.value),
          );
          if (words.length > 0)
            this.codeString(words, text, scope, nested(`tmux ${sub}`), undefined);
          // A quoted command after an option belayd does not know is still found.
          for (const w of words.slice(1))
            if (/\s/.test(w.value))
              this.codeString([w], text, scope, nested(`tmux ${sub}`), undefined);
          if (sub === 'send-keys' || sub === 'send') {
            // Keys are typed one after another, without spaces in between.
            const typed = words.map((w) => w.value).join('');
            const resolved = words.every((w) => w.resolved);
            this.codeString(
              [{ ...literal(typed), resolved }],
              text,
              scope,
              nested('tmux send-keys'),
              undefined,
            );
          }
          i = end;
        }
        return program;
      }
      case 'screen': {
        // `screen -dm cmd args...` runs a command; `screen -X stuff 'text'` types into one.
        let i = 0;
        for (; i < args.length; i++) {
          const v = args[i]!.value;
          if (!v.startsWith('-') || v === '-') break;
          if (v === '-X') {
            const typed = args[i + 2];
            const command = args[i + 1]?.value;
            // `-X screen cmd` opens a window running cmd; exec and eval run more than that.
            if (command === 'screen') {
              // `-X screen -t title 2 cmd args`: options, an optional window number, the command.
              const rest = getoptPositionals(args.slice(i + 2), 'thT');
              if (/^\d+$/.test(rest[0]?.value ?? '')) rest.shift();
              if (rest.length > 0) this.invoke(rest, text, scope, nested('screen -X'), stdin, []);
            } else if (command === 'exec' || command === 'eval' || command === 'source') {
              inv.dynamic = true;
              inv.note = `screen -X ${command} runs commands that belayd does not follow`;
            }
            // screen turns `\n` and `\r` in the typed text into Enter.
            if (command === 'stuff' && typed)
              this.codeString(
                [{ ...typed, value: typed.value.replace(/\\[nr]/g, '\n') }],
                text,
                scope,
                nested('screen -X'),
                undefined,
              );
            return program;
          }
          const letters = v.slice(1);
          const at = letters.search(/[SceshptT]/);
          if (at >= 0 && at === letters.length - 1) i++; // `-S name`, `-dmS name`
        }
        const rest = args.slice(i);
        if (rest.length > 0) this.invoke(rest, text, scope, nested('screen'), stdin, []);
        return program;
      }
      case 'at':
      case 'batch': {
        // The commands come from `-f file` or from stdin, and run later in a shell.
        const f = args.findIndex((w) => w.value === '-f');
        if (f >= 0 && args[f + 1]) this.runScript(inv, args[f + 1]!, scope, ctx, false, true, []);
        else if (!args.some((w) => /^-[lrdc]$/.test(w.value)))
          this.stdinCode(inv, stdin, scope, nested(program), true);
        return program;
      }
      case 'parallel': {
        // `parallel rm -rf ::: ~` runs the command once per item after `:::`.
        const rest = skipOptions(args, VALUE_OPTIONS.parallel);
        const sep = rest.findIndex((w) => w.value === ':::' || w.value === '::::');
        const command = sep >= 0 ? rest.slice(0, sep) : rest;
        // `::::` takes the items from files, which belayd does not read.
        const items =
          sep >= 0 && rest[sep]!.value === ':::'
            ? rest.slice(sep + 1)
            : [unknownWord(sep >= 0 ? '<items from a file>' : '<items from stdin>')];
        // With no command, each item is a command of its own.
        if (command.length === 0) {
          for (const item of items)
            this.codeString([item], text, scope, nested('parallel'), undefined);
          return program;
        }
        const code = command.map((w) => w.value).join(' ');
        const filled = code.includes('{}')
          ? [
              {
                ...literal(code.replaceAll('{}', items.map((w) => w.value).join(' '))),
                resolved: command.every((w) => w.resolved) && items.every((w) => w.resolved),
              },
            ]
          : [...command, ...items].map((w) => ({ ...w, value: quote(w.value) }));
        this.codeString(filled, text, scope, nested('parallel'), undefined);
        return program;
      }
      case 'watch': {
        const rest = skipOptions(args, VALUE_OPTIONS.watch);
        if (rest.length > 0) this.codeString(rest, text, scope, nested('watch'), undefined);
        return program;
      }
      case 'flock': {
        const rest = skipOptions(args, VALUE_OPTIONS.flock).slice(1);
        const c = rest.findIndex((w) => w.value === '-c' || w.value === '--command');
        if (c >= 0)
          this.codeString(rest.slice(c + 1, c + 2), text, scope, nested('flock -c'), undefined);
        else if (rest.length > 0) this.invoke(rest, text, scope, nested('flock'), stdin, []);
        return program;
      }
      case 'su':
      case 'runuser': {
        const c = args.findIndex((w) => w.value === '-c' || w.value === '--command');
        if (c >= 0)
          this.codeString(
            args.slice(c + 1, c + 2),
            text,
            scope,
            nested(`${program} -c`),
            undefined,
          );
        return program;
      }
      case 'eval':
        if (ctx.scripts?.length && resetsArguments(args)) {
          delete scope.positional;
          return program;
        }
        this.codeString(args, text, scope, nested('eval'), stdin);
        return program;
      case 'source':
      case '.': {
        const file = args[0];
        if (file) {
          inv.codeFrom = this.codeSources(file, scope);
          const rest = args.slice(1);
          this.runScript(inv, file, scope, ctx, true, true, rest.length > 0 ? rest : undefined);
        }
        return program;
      }
      case 'ssh': {
        const rest = skipOptions(args, VALUE_OPTIONS.ssh);
        if (rest.length > 1) {
          this.codeString(
            rest.slice(1),
            text,
            { ...scope, cwd: undefined },
            { ...nested('ssh'), remote: true },
            undefined,
          );
        }
        return program;
      }
      case 'git': {
        // `git -C dir` runs in another directory; `git -c alias.x='!cmd' x` runs a shell command.
        for (let i = 0; i < args.length; i++) {
          const w = args[i]!;
          if (!w.value.startsWith('-')) break;
          if (w.value === '-C' && args[i + 1]) {
            const dir = args[i + 1]!;
            inv.cwd = dir.resolved ? resolveIn(scope.cwd, dir.value, this.opts.home) : undefined;
          }
          if (w.value === '-c' && args[i + 1]) {
            const m = /^alias\.[^=]+=!(.*)$/s.exec(args[i + 1]!.value);
            if (m) this.source(m[1]!, scope, nested('git alias'), undefined);
          }
          if (VALUE_OPTIONS.git!.has(w.value)) i++;
        }
        return program;
      }
      case 'npm':
      case 'pnpm':
      case 'yarn': {
        // `npm exec x`, `pnpm dlx x`, `yarn dlx x` run a package binary like npx.
        const sub = args[0]?.value;
        if (sub === 'exec' || sub === 'dlx' || sub === 'x')
          this.runner(args.slice(1), text, scope, nested(`${program} ${sub}`), stdin);
        return program;
      }
    }

    if (RUNNERS.has(program)) {
      const c = args.findIndex((w) => w.value === '-c' || w.value === '--call');
      if (c >= 0)
        this.codeString(args.slice(c + 1, c + 2), text, scope, nested(`${program} -c`), stdin);
      else this.runner(args, text, scope, nested(program), stdin);
      return program;
    }

    if (SHELLS.has(program)) {
      this.shell(inv, args, text, scope, nested(`${program} -c`), stdin);
      return program;
    }

    this.trackVirtualenv(program, args, scope);

    if (AWKS.has(program)) {
      this.awk(inv, args, text, scope, nested(`${program} program`));
      return program;
    }

    const interp = INTERPRETERS[program.replace(/[\d.]+$/, '')] ?? INTERPRETERS[program];
    if (interp) {
      const lower = args.map((w) => w.value.toLowerCase());
      if (lower.some((a) => interp.inline.includes(a))) {
        inv.inlineCode = true;
        for (const w of args) inv.codeFrom.push(...w.subPrograms);
        if (!this.inlineCode(program, args, text, scope, nested(`${program} code`))) {
          inv.dynamic = true;
          inv.note = 'runs inline code too large for belayd to check';
        }
      } else if (!lower.some((a) => interp.module?.includes(a))) {
        // `python3 - "$f" <<'EOF'`: `-` means the code comes from stdin, and what follows
        // are its arguments, not a script.
        const script = args.find((w) => w.value === '-' || !w.value.startsWith('-'));
        if (script && script.value !== '-') {
          inv.codeFrom.push(...this.codeSources(script, scope));
          this.runScript(inv, script, scope, ctx, false, false);
          this.agentScript(program, inv, script, scope, ctx, text);
        } else {
          this.stdinCode(inv, stdin, scope, ctx, false);
          // Code given on stdin (`python3 - <<'EOF'`) is read like `python -c` code.
          if (stdin?.text !== undefined && stdin.text.length <= MAX_INLINE_CODE)
            this.scanCode(program, stdin.text, text, scope, nested(`${program} stdin`));
        }
      }
    }
    return program;
  }

  private shell(
    inv: Invocation,
    args: EvalWord[],
    text: string,
    scope: Scope,
    ctx: Ctx,
    stdin: StdinInfo | undefined,
  ): void {
    let commandMode = false;
    let stdinMode = false;
    let i = 0;
    for (; i < args.length; i++) {
      const v = args[i]!.value;
      if (v === '--') {
        i++;
        break;
      }
      const flags = /^-[A-Za-z]+$/.test(v) ? v : '';
      if (flags.includes('c')) commandMode = true;
      else if (flags.includes('s')) stdinMode = true;
      else if (v === '-o' || v === '+o' || v === '-O' || v === '+O') i++;
      else if (!v.startsWith('-') && !v.startsWith('+')) break;
    }
    const first = args[i];
    if (commandMode) {
      if (!first) return;
      // `bash -c 'code' name a b`: inside, $0 is name and $1, $2 are a and b, not the
      // caller's.
      // Functions stay visible: `export -f` hands them to the new shell, and checking a
      // call against a function as well as the command only makes belayd stricter.
      const inner = cloneScope(scope);
      const after = args.slice(i + 1);
      const zero = after[0];
      inner.vars.set('0', zero ? (zero.resolved ? zero.value : null) : inv.program);
      if (after.slice(1).every((w) => w.resolved))
        inner.positional = after.slice(1).map((w) => w.value);
      else delete inner.positional;
      this.codeString([first], text, inner, ctx, stdin);
      return;
    }
    // `sh -s args...` reads its code from stdin and treats the rest as arguments.
    if (first && !stdinMode) {
      inv.codeFrom.push(...this.codeSources(first, scope));
      this.runScript(inv, first, scope, ctx, false, true, args.slice(i + 1));
      return;
    }
    // `bash < x.sh` and `sh -s < x.sh` read the script from a file.
    const input = inv.redirects.findLast((r) => r.op === '<');
    if (input) {
      if (!input.resolved) {
        inv.dynamic = true;
        inv.note = 'runs a script whose name is only known at run time';
      } else this.runScript(inv, literal(input.target), scope, ctx, false, true, args.slice(i));
      return;
    }
    this.stdinCode(inv, stdin, scope, ctx, true);
  }

  /** An interpreter reading its program from stdin. */
  private stdinCode(
    inv: Invocation,
    stdin: StdinInfo | undefined,
    scope: Scope,
    ctx: Ctx,
    parseAsShell: boolean,
  ): void {
    if (!stdin) return;
    inv.codeFrom.push(...stdin.producers);
    if (stdin.text !== undefined && parseAsShell) {
      this.source(
        stdin.text,
        cloneScope(scope),
        { ...ctx, depth: ctx.depth + 1, via: [...ctx.via, `${inv.program} stdin`] },
        undefined,
      );
    } else if (stdin.producers.length > 0) {
      inv.dynamic = true;
      inv.note = `runs code piped in from \`${stdin.producers.join(' | ')}\``;
    }
  }

  /** Runs a string as shell code: `bash -c`, `eval`, `su -c`, remote `ssh` commands. */
  private codeString(
    words: EvalWord[],
    text: string,
    scope: Scope,
    ctx: Ctx,
    stdin: StdinInfo | undefined,
  ): void {
    if (words.length === 0) return;
    const code = words.map((w) => w.value).join(' ');
    if (words.every((w) => w.resolved)) {
      this.source(code, cloneScope(scope), ctx, stdin);
      return;
    }
    this.pushDynamic(
      text,
      scope,
      ctx,
      'runs shell code that is only known at run time',
      words.flatMap((w) => w.subPrograms),
    );
  }

  private runner(
    args: EvalWord[],
    text: string,
    scope: Scope,
    ctx: Ctx,
    stdin: StdinInfo | undefined,
  ): void {
    const rest = skipOptions(args, VALUE_OPTIONS.npx);
    const pkg = rest[0];
    if (!pkg) return;
    const bin = pkg.value.replace(/^(@[^/]+\/[^@]+|[^@]+)@.*$/, '$1');
    this.invoke(
      [{ ...pkg, value: PACKAGE_COMMANDS.get(bin) ?? path.posix.basename(bin) }, ...rest.slice(1)],
      text,
      scope,
      ctx,
      stdin,
      [],
    );
  }

  private find(args: EvalWord[], text: string, scope: Scope, ctx: Ctx): void {
    const roots: EvalWord[] = [];
    let i = 0;
    for (; i < args.length; i++) {
      const v = args[i]!.value;
      if (v.startsWith('-') || v === '(' || v === '!' || v === ')') break;
      roots.push(args[i]!);
    }
    if (roots.length === 0) roots.push(literal('.'));
    for (; i < args.length; i++) {
      const v = args[i]!.value;
      if (v === '-delete') {
        this.invoke(
          [literal('rm'), literal('-r'), ...roots],
          text,
          scope,
          { ...ctx, via: [...ctx.via.slice(0, -1), 'find -delete'] },
          undefined,
          [],
        );
      }
      if (v === '-exec' || v === '-execdir' || v === '-ok' || v === '-okdir') {
        const inner: EvalWord[] = [];
        for (i++; i < args.length; i++) {
          const t = args[i]!.value;
          if (t === ';' || t === '+') break;
          if (t === '{}') inner.push(...roots);
          else inner.push(args[i]!);
        }
        if (inner.length > 0)
          this.invoke(
            inner,
            text,
            scope,
            { ...ctx, via: [...ctx.via.slice(0, -1), `find ${v}`] },
            undefined,
            [],
          );
      }
    }
  }

  /** Where the code for `bash file`, `source file` or `python file` comes from. */
  private codeSources(file: EvalWord, scope: Scope): string[] {
    if (file.subPrograms.length > 0) return file.subPrograms; // bash <(curl ...)
    if (!file.resolved) return [];
    const resolved = resolveIn(scope.cwd, file.value, this.opts.home);
    const downloader = resolved ? scope.downloads.get(resolved) : undefined;
    return downloader ? [downloader] : [];
  }

  /**
   * Inline code (`python -c`, `node -e`, `perl -e`, `osascript -e`) cannot be analysed
   * in general, but the common dangerous shapes can: shell commands passed to
   * system()/exec()/subprocess, and string paths given to delete or open calls.
   * Returns false when the code is too large to scan.
   */
  private inlineCode(
    interpreter: string,
    args: EvalWord[],
    text: string,
    scope: Scope,
    ctx: Ctx,
  ): boolean {
    const code = args
      .filter((w) => w.resolved)
      .map((w) => w.value)
      .join('\n');
    if (code.length > MAX_INLINE_CODE) return false;
    this.scanCode(interpreter, code, text, scope, ctx);
    return true;
  }

  /**
   * A script in another language that the agent wrote earlier in this session. Other
   * scripts are judged by their command line alone, as before: reading every build
   * script in a project would mostly produce noise. One the agent just wrote is the
   * write-then-run case, so its shell calls, deletes and reads are checked like
   * `python -c` code. This only ever adds findings.
   */
  private agentScript(
    interpreter: string,
    inv: Invocation,
    file: EvalWord,
    scope: Scope,
    ctx: Ctx,
    text: string,
  ): void {
    if (!file.resolved || this.exhausted || ctx.depth >= MAX_DEPTH) return;
    const abs = resolveIn(scope.cwd, file.value, this.opts.home);
    if (!abs) return;
    // Written earlier in this same command, with known text: read that.
    const known = scope.contents.get(abs);
    let script: { text: string; truncated: boolean } | undefined;
    if (typeof known === 'string') script = { text: known, truncated: false };
    else {
      if (scope.written.has(abs) || !this.opts.agentWrote?.(abs) || !this.opts.readScript) return;
      script = this.opts.readScript(abs);
    }
    if (!script) return;
    if (script.truncated || script.text.length > MAX_INLINE_CODE) {
      inv.dynamic = true;
      inv.note = `runs ${file.value}, which the agent wrote in this session and which is too large for belayd to check`;
      return;
    }
    this.scanCode(interpreter, script.text, text, scope, {
      ...ctx,
      via: [...ctx.via, path.posix.basename(abs)],
    });
  }

  /** Shell calls, deletes and reads in Python, Node, Ruby or Perl code, checked as commands. */
  private scanCode(interpreter: string, code: string, text: string, scope: Scope, ctx: Ctx): void {
    // Python's exec() runs Python, not a shell.
    const shellCalls = interpreter.startsWith('python')
      ? SHELL_CALLS.filter((c) => c !== 'exec')
      : SHELL_CALLS;
    for (const body of callArguments(code, shellCalls, false))
      this.source(unquote(body), cloneScope(scope), { ...ctx, depth: ctx.depth + 1 }, undefined);
    for (const body of callArguments(code, REMOVE_CALLS, false)) {
      const target = expandUser(unquote(body), this.opts.home);
      this.invoke([literal('rm'), literal('-r'), literal(target)], text, scope, ctx, undefined, []);
    }
    for (const body of callArguments(code, READ_CALLS, true)) {
      const target = expandUser(unquote(body), this.opts.home);
      this.invoke([literal('cat'), literal(target)], text, scope, ctx, undefined, []);
    }
    // The command as separate words: `subprocess.run(["rm", "-rf", p])`,
    // `spawnSync("rm", ["-rf", p])`, Ruby's and Perl's `system("rm", "-rf", dir)`. A word
    // that is not a plain string is unknown, so `rm -rf <unknown>` still asks.
    const varargs = /^(ruby|perl)/.test(interpreter);
    for (const args of callArgs(code, varargs ? VARARG_CALLS : ARGV_CALLS)) {
      const [a, b] = args;
      let words: (string | undefined)[] | undefined;
      if (a?.kind === 'list') words = a.items;
      else if (a?.kind === 'string' && b?.kind === 'list') words = [a.value, ...b.items];
      else if (
        varargs &&
        a?.kind === 'string' &&
        args.length > 1 &&
        args.every((x) => x.kind !== 'list')
      )
        words = args.map((x) => (x.kind === 'string' ? x.value : undefined));
      const program = words?.[0];
      if (!words || program === undefined || program === '') continue;
      this.invoke(
        words.map((w) => (w === undefined ? unknownWord('<a value from the code>') : literal(w))),
        text,
        cloneScope(scope),
        { ...ctx, depth: ctx.depth + 1 },
        undefined,
        [],
      );
    }
  }

  /** `uv run cmd`, `poetry run cmd`, `doppler run -- cmd`: checks the command they start. */
  private envRunner(
    program: string,
    spec: EnvRunner,
    args: EvalWord[],
    text: string,
    scope: Scope,
    stdin: StdinInfo | undefined,
    nested: (via: string) => Ctx,
  ): boolean {
    const takesValue = new Set(spec.value ?? []);
    let i = 0;
    let via = program;
    if (spec.sub) {
      // Options before the subcommand (`poetry -C dir run`).
      while (i < args.length && args[i]!.value.startsWith('-') && args[i]!.value !== '--') {
        if (takesValue.has(args[i]!.value)) i++;
        i++;
      }
      const sub = args[i]?.value;
      if (sub === undefined || !spec.sub.includes(sub)) return false;
      via = `${program} ${sub}`;
      i++;
    }
    const rest = args.slice(i);
    const inner = spec.chdir ? this.withChdir(rest, spec.chdir, scope) : scope;
    const ctx = nested(via);

    const dashDash = rest.findIndex((w) => w.value === '--');
    let cmd: EvalWord[] | undefined;
    for (let j = 0; j < rest.length; j++) {
      const v = rest[j]!.value;
      if (spec.string?.includes(v)) {
        const code = rest[j + 1];
        if (code) this.codeString([code], text, inner, ctx, stdin);
        return true;
      }
      const eq = spec.string?.find((o) => v.startsWith(`${o}=`));
      if (eq) {
        this.codeString([{ ...rest[j]!, value: v.slice(eq.length + 1) }], text, inner, ctx, stdin);
        return true;
      }
      if (spec.argvAfter?.includes(v)) {
        cmd = rest.slice(j + 1);
        break;
      }
      if (v === '--') {
        cmd = rest.slice(j + 1);
        break;
      }
      if (spec.argvAfter || spec.afterDashDash) {
        if (takesValue.has(v)) j++;
        continue;
      }
      if (!v.startsWith('-') || v === '-') {
        cmd = rest.slice(j);
        break;
      }
      if (takesValue.has(v)) j++;
    }
    if (!cmd && spec.afterDashDash === false && dashDash >= 0) cmd = rest.slice(dashDash + 1);
    if (!cmd || cmd.length === 0) return true;
    if (spec.skip) cmd = cmd.slice(spec.skip);
    // `aws-vault exec PROFILE -- cmd`; python-dotenv's `dotenv run cmd`.
    if (cmd[0]?.value === '--' || (program === 'dotenv' && cmd[0]?.value === 'run'))
      cmd = cmd.slice(1);
    if (cmd[0]?.value === '--') cmd = cmd.slice(1);
    if (cmd.length === 0) return true;
    // `hatch run test:pytest` runs pytest in the test environment.
    if (program === 'hatch' && /^[\w.-]+:./.test(cmd[0]!.value))
      cmd = [{ ...cmd[0]!, value: cmd[0]!.value.replace(/^[\w.-]+:/, '') }, ...cmd.slice(1)];
    if (spec.pyFiles && /\.py$/.test(cmd[0]!.value)) cmd = [literal('python'), ...cmd];
    this.invoke(cmd, text, inner, ctx, stdin, []);
    return true;
  }

  /** The scope for a command that a wrapper runs in another folder (`env -C dir`, `sudo -D dir`). */
  private withChdir(options: EvalWord[], flags: string[], scope: Scope): Scope {
    let dir: EvalWord | undefined;
    for (let i = 0; i < options.length; i++) {
      const v = options[i]!.value;
      const long = [...flags, '--chdir'].find((f) => f.startsWith('--') && v.startsWith(`${f}=`));
      if (flags.includes(v)) dir = options[i + 1];
      else if (long) dir = { ...options[i]!, value: v.slice(long.length + 1) };
    }
    if (!dir) return scope;
    const inner = cloneScope(scope);
    const from = folders(scope);
    this.setCwd(
      inner,
      dir.resolved ? from.map((f) => resolveIn(f, dir.value, this.opts.home)) : [undefined],
    );
    return inner;
  }

  /** `python -m venv dir`, `virtualenv dir` and `uv venv [dir]` write an activate script. */
  private trackVirtualenv(program: string, args: EvalWord[], scope: Scope): void {
    const values = args.map((w) => (w.resolved ? w.value : undefined));
    let rest: (string | undefined)[] | undefined;
    if (/^python[\d.]*$/.test(program)) {
      // Only Python's own `-m venv`, before any script or inline code.
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === undefined || v === '-c' || !v.startsWith('-')) break;
        if (v === '-m') {
          if (/^(venv|virtualenv)$/.test(values[i + 1] ?? '')) rest = values.slice(i + 2);
          break;
        }
        if (v === '-W' || v === '-X') i++;
      }
    } else if (program === 'virtualenv') rest = values;
    else if (program === 'uv' && values[0] === 'venv') rest = [...values.slice(1), '.venv'];
    const dir = rest?.find((v) => v !== undefined && !v.startsWith('-'));
    const abs = dir ? resolveIn(scope.cwd, dir, this.opts.home) : undefined;
    if (!abs) return;
    for (const name of ['activate', 'activate.fish', 'activate.csh'])
      scope.generated.add(path.join(abs, 'bin', name));
  }

  /**
   * awk programs run shell commands through system(), `"cmd" | getline` and
   * `print | "cmd"`. Those are read like any other command.
   */
  private awk(inv: Invocation, args: EvalWord[], text: string, scope: Scope, ctx: Ctx): void {
    let program: EvalWord | undefined;
    for (let i = 0; i < args.length; i++) {
      const v = args[i]!.value;
      if (v === '-f' || v === '--file') return; // the program is in a file
      if (/^-[vFW]$/.test(v) || v === '--assign' || v === '--field-separator') i++;
      else if (!v.startsWith('-')) {
        program = args[i];
        break;
      }
    }
    if (!program) return;
    if (!program.resolved) {
      inv.dynamic = true;
      inv.note = 'runs an awk program that is only known at run time';
      return;
    }
    const code = program.value;
    if (code.length > MAX_INLINE_CODE) {
      inv.dynamic = true;
      inv.note = 'runs an awk program too large for belayd to check';
      return;
    }
    const commands = awkCommands(code);
    if (commands === undefined) {
      inv.dynamic = true;
      inv.note = 'runs a command from an awk program that is only known at run time';
      return;
    }
    for (const c of commands)
      this.source(c, cloneScope(scope), { ...ctx, depth: ctx.depth + 1 }, undefined);
  }

  /**
   * A script about to run. Shell scripts are read and checked line by line, like
   * anything typed. A script written earlier in the same command cannot be read in
   * advance, so it counts as code belayd cannot see.
   */
  private runScript(
    inv: Invocation,
    file: EvalWord,
    scope: Scope,
    ctx: Ctx,
    sameScope: boolean,
    parse: boolean | 'shebang',
    /** The script's own arguments, which `$1` and `"$@"` stand for inside it. */
    scriptArgs?: EvalWord[],
  ): void {
    if (file.subPrograms.length > 0) {
      // `bash <(curl ...)` is judged by where the code comes from. `source <(echo 'rm
      // -rf ~')` holds code belayd can read; anything else it cannot see.
      if (!parse) return;
      if (file.substituted !== undefined)
        this.source(
          file.substituted,
          sameScope ? scope : cloneScope(scope),
          { ...ctx, depth: ctx.depth + 1, via: [...ctx.via, `<(${file.subPrograms.join(' | ')})`] },
          undefined,
        );
      else if (!file.subPrograms.some((p) => NETWORK_FETCHERS.has(p))) {
        inv.dynamic = true;
        inv.note = `runs code produced by \`${file.subPrograms.join(' | ')}\``;
      }
      return;
    }
    if (!file.resolved) {
      if (parse === true) {
        inv.dynamic = true;
        inv.note = 'runs a script whose name is only known at run time';
      }
      return;
    }
    const abs = resolveIn(scope.cwd, file.value, this.opts.home);
    if (!abs) {
      // A relative script in a folder belayd cannot tell: it cannot be read first.
      if (parse) {
        inv.dynamic = true;
        inv.note = `runs ${file.value} in a folder that is only known at run time`;
      }
      return;
    }
    inv.scripts.push(abs);
    // Written earlier in this same command: readable only when exactly what was written
    // is known (`cat > x.sh <<'EOF'`).
    const writtenHere = scope.written.has(abs) && !scope.downloads.has(abs);
    const recorded = writtenHere ? scope.contents.get(abs) : undefined;
    const known = typeof recorded === 'string' ? recorded : undefined;
    if (writtenHere && known === undefined) {
      inv.dynamic = true;
      inv.note = `runs ${file.value}, which this same command writes first, so belayd cannot read it in advance`;
      return;
    }
    if (!parse || this.exhausted || (known === undefined && !this.opts.readScript)) return;
    const unseen = (why: string) => {
      inv.dynamic = true;
      inv.note = `runs ${file.value}, which ${why}`;
    };
    // With parallel tool calls, the agent may be writing this script right now. A script
    // that does not exist yet cannot be read, so it counts as code belayd cannot see.
    if (known === undefined && this.opts.fileExists && !this.opts.fileExists(abs)) {
      if (scope.generated.has(abs)) return; // `python -m venv .venv && source .venv/bin/activate`
      return unseen('does not exist yet, so belayd cannot read it first');
    }
    const script =
      known !== undefined
        ? { text: known, truncated: known.length > MAX_SOURCE_CHARS }
        : this.opts.readScript!(abs);
    if (!script) return unseen('belayd cannot read');
    const head = script.text.slice(0, 1024);
    // A text file without `#!` is run by the shell itself; a binary has NUL bytes early on.
    const shellish =
      /\.(sh|bash|zsh)$/.test(abs) ||
      /^#!.*\b(ba|z|da|k)?sh\b/.test(head) ||
      (!head.startsWith('#!') && !head.includes('\0'));
    if (parse === 'shebang' && !shellish) {
      // `./build.py` with `#!/usr/bin/env python3`: read it if the agent wrote it.
      const interpreter = /^#!.*?\b(python[\d.]*|node|nodejs|bun|deno|ruby|perl|php)\b/.exec(
        head,
      )?.[1];
      if (interpreter) this.agentScript(interpreter, inv, file, scope, ctx, file.value);
      return;
    }
    if (script.truncated) return unseen('is too large for belayd to check');
    const target = sameScope ? scope : cloneScope(scope);
    const callerArgs = target.positional;
    const callerName = target.vars.get('0');
    if (scriptArgs) {
      if (scriptArgs.every((w) => w.resolved)) target.positional = scriptArgs.map((w) => w.value);
      else delete target.positional;
    }
    if (!sameScope) target.vars.set('0', file.value);
    // A script that runs itself with the same arguments is already being checked. With
    // other arguments it can do other things, so it is read again (up to the depth limit).
    const key = `${abs}\0${target.positional?.join('\0') ?? '\u0001'}`;
    const restore = () => {
      if (!sameScope || !scriptArgs) return;
      // `source x.sh a b` sets the arguments only while x.sh runs.
      if (callerArgs) target.positional = callerArgs;
      else delete target.positional;
      if (callerName !== undefined) target.vars.set('0', callerName);
    };
    if (ctx.scripts?.includes(key)) return restore();
    if (ctx.depth >= MAX_DEPTH) {
      restore();
      return unseen('runs other scripts nested too deeply to check');
    }
    // A file this same command wrote is never "your committed script", whatever Git says.
    const trusted = !scope.written.has(abs) && this.opts.trustedScript?.(abs) === true;
    this.source(
      script.text,
      target,
      {
        ...ctx,
        depth: ctx.depth + 1,
        via: [...ctx.via, path.posix.basename(abs)],
        scripts: [...(ctx.scripts ?? []), key],
        trusted,
      },
      undefined,
    );
    restore();
  }

  private trackWrites(
    program: string,
    words: EvalWord[],
    redirects: Redirect[],
    scope: Scope,
  ): void {
    const add = (p: string) => {
      const abs = resolveIn(scope.cwd, p, this.opts.home);
      if (abs) scope.written.add(abs);
    };
    for (const r of redirects) if (r.op.includes('>') && r.resolved) add(r.target);
    const args = words.slice(1).filter((w) => w.resolved && !w.value.startsWith('-'));
    if (program === 'tee') args.forEach((w) => add(w.value));
    if (['cp', 'mv', 'install', 'ln'].includes(program) && args.length > 1) {
      add(args[args.length - 1]!.value);
    }
    for (const file of scope.downloads.keys()) scope.written.add(file);
  }

  private trackDownloads(
    program: string,
    args: EvalWord[],
    redirects: Redirect[],
    scope: Scope,
  ): void {
    if (!NETWORK_FETCHERS.has(program)) return;
    const record = (file: string) => {
      const resolved = resolveIn(scope.cwd, file, this.opts.home);
      if (resolved && file !== '-') scope.downloads.set(resolved, program);
    };
    for (let i = 0; i < args.length; i++) {
      const v = args[i]!.value;
      if (
        (v === '-o' || v === '--output' || v === '-O' || v === '--output-document') &&
        args[i + 1]
      ) {
        if (program === 'wget' || v.startsWith('--output') || v === '-o')
          record(args[i + 1]!.value);
      } else if (v.startsWith('--output=')) record(v.slice('--output='.length));
      else if (v.startsWith('--output-document=')) record(v.slice('--output-document='.length));
    }
    for (const r of redirects) if (r.op.startsWith('>') && r.resolved) record(r.target);
  }

  /** What a command prints, when we can know it without running anything. */
  private staticStdout(
    program: string,
    words: EvalWord[],
    stdin: StdinInfo | undefined,
    tmpdirChanged = false,
  ): string | undefined {
    const args = words.slice(1);
    if (!args.every((w) => w.resolved)) return undefined;
    switch (program) {
      case 'echo': {
        // Leading -n, -e and -E words are options (any number of them); other words
        // starting with `-` are printed. zsh ends options at a lone `-`, bash prints it.
        let first = 0;
        while (/^-[neE]+$/.test(args[first]?.value ?? '')) first++;
        if (args[first]?.value === '-') return undefined;
        const rest = args.slice(first);
        // Some echos turn `\x72` into `r` and some do not, so escapes leave the output unknown.
        if (rest.some((w) => w.value.includes('\\'))) return undefined;
        return rest.map((w) => w.value).join(' ') + '\n';
      }
      case 'printf': {
        const [fmt, ...rest] = args.map((w) => w.value);
        if (fmt === undefined || fmt.startsWith('-')) return undefined;
        if (fmt === '%s' || fmt === '%s\\n') return rest.join('') + (fmt.endsWith('n') ? '\n' : '');
        // Only `\n` and `\t` are followed; any other escape or format leaves it unknown.
        if (fmt.includes('%') || /\\[^nt]/.test(fmt) || fmt.endsWith('\\')) return undefined;
        return unescape(fmt);
      }
      case 'cat':
      case 'tee':
        if (program === 'cat' && args.some((w) => w.value !== '-')) return undefined;
        return stdin?.text;
      case 'mktemp': {
        // A fresh name in the temporary folder. Only the plain forms are followed: any
        // other option (`--tmpdir=DIR`, `-pDIR`) or a changed TMPDIR leaves it unknown.
        if (tmpdirChanged) return undefined;
        let template: string | undefined;
        for (let i = 0; i < args.length; i++) {
          const v = args[i]!.value;
          if (/^-[dqu]+$/.test(v)) continue;
          // `-t` puts the name in the temporary folder too, with or without a prefix.
          if (v === '-t') {
            const next = args[i + 1]?.value;
            if (next !== undefined && !next.startsWith('-') && !next.includes('/')) i++;
            continue;
          }
          if (v.startsWith('-') || template !== undefined) return undefined;
          template = v;
        }
        if (template?.includes('/')) return undefined;
        const base = this.opts.env?.TMPDIR ?? '/tmp';
        return `${base.replace(/\/+$/, '')}/tmp.belayd\n`;
      }
      case 'base64': {
        const decode = args.some((w) => ['-d', '-D', '--decode'].includes(w.value));
        if (!decode || stdin?.text === undefined) return undefined;
        try {
          return Buffer.from(stdin.text.replace(/\s+/g, ''), 'base64').toString('utf8');
        } catch {
          return undefined;
        }
      }
      default:
        return undefined;
    }
  }

  private redirects(
    list: readonly Redirection[],
    src: string,
    scope: Scope,
    ctx: Ctx,
  ): { redirects: Redirect[]; inline: string | undefined; exact: boolean } {
    const redirects: Redirect[] = [];
    let inline: string | undefined;
    // A heredoc with expansions in it is not known word for word.
    let exact = true;
    for (const r of list) {
      if (r.type === 'HereDoc') {
        if (r.body.parts) this.evalParts(r.body.parts, src, scope, ctx, true);
        if (r.body.parts && r.body.parts.length > 0) exact = false;
        inline ??= r.body.text;
      } else if (r.type === 'HereString') {
        if (r.target) inline ??= this.evalWord(r.target, src, scope, ctx).value + '\n';
      } else if (r.target) {
        const target = this.evalWord(r.target, src, scope, ctx);
        // `>&2` and `2>&1` duplicate file descriptors; they are not files.
        if ((r.operator === '>&' || r.operator === '<&') && /^(\d+|-)$/.test(target.value))
          continue;
        // `2> file` carries its descriptor as `{ type: 'FileDescriptor', value: 2 }`.
        const descriptor = (r as { descriptor?: { value?: unknown } }).descriptor;
        const fd = typeof descriptor?.value === 'number' ? descriptor.value : undefined;
        redirects.push({
          op: r.operator,
          target: target.value,
          resolved: target.resolved,
          ...(fd !== undefined ? { fd } : {}),
        });
      }
    }
    return { redirects, inline, exact };
  }

  private evalAssignment(
    a: Extract<CommandArgument, { type: 'Assignment' }>,
    src: string,
    scope: Scope,
    ctx: Ctx,
  ): EvalWord {
    if (a.value.type === 'ArrayValue') {
      const words = a.value.elements.map((w) => this.evalWord(w, src, scope, ctx));
      return {
        text: a.text,
        value: words.map((w) => w.value).join(' '),
        values: [],
        resolved: words.every((w) => w.resolved),
        subPrograms: words.flatMap((w) => w.subPrograms),
      };
    }
    return this.evalWord(a.value, src, scope, ctx);
  }

  evalWord(word: Word, src: string, scope: Scope, ctx: Ctx): EvalWord {
    if (!word.parts) {
      const value = expandTilde(word.text, word.value, this.opts.home);
      const resolved = !/\$\{?=/.test(word.text); // zsh's `$=X`, see below
      return { text: word.text, value, values: [value], resolved, subPrograms: [] };
    }
    const r = this.evalParts(word.parts, src, scope, ctx, false);
    const raw = r.alternatives.map((v) =>
      word.text.startsWith('~') ? expandTilde(word.text, v, this.opts.home) : v,
    );
    const values = raw.map((v) => v.replaceAll(FIELD_BREAK, ' '));
    const result: EvalWord = {
      text: word.text,
      value: values[0] ?? '',
      values,
      resolved: r.resolved,
      subPrograms: r.subPrograms,
      ...(r.envOnly ? { envOnly: true } : {}),
      ...(r.substituted !== undefined ? { substituted: r.substituted } : {}),
    };
    if (r.choice) {
      const probe = this.evalParts(word.parts, src, scope, ctx, false, true);
      if (probe.resolved && probe.complete && r.complete) result.exhaustive = true;
      if (probe.resolved)
        result.candidates = probe.alternatives
          .map((v) => (word.text.startsWith('~') ? expandTilde(word.text, v, this.opts.home) : v))
          .map((v) => v.split(FIELD_BREAK).filter(Boolean));
    }
    if (raw.some((v) => v.includes(FIELD_BREAK)) || (r.bare && raw.every((v) => v === '')))
      result.fields = raw.map((v) => v.split(FIELD_BREAK).filter(Boolean));
    // zsh's `$=X` and `${=X}` split a variable into words where bash would not.
    if (/\$\{?=/.test(word.text)) {
      result.resolved = false;
      delete result.envOnly;
    }
    return result;
  }

  /**
   * Expands the parts of one word. Outside double quotes, the result of an expansion is
   * split into words at whitespace, like the shell does: the breaks are marked with
   * FIELD_BREAK and turned into separate words by expandWord.
   */
  private evalParts(
    parts: readonly WordPart[],
    src: string,
    scope: Scope,
    ctx: Ctx,
    quoted: boolean,
    /** Expand variables that branches left as a few known values into those values. */
    useChoices = false,
  ): {
    alternatives: string[];
    resolved: boolean;
    subPrograms: string[];
    bare: boolean;
    envOnly: boolean;
    /** Some alternatives are values a branch may have left, not brace expansion. */
    choice: boolean;
    /** Every variable with candidates used here has a complete list. */
    complete: boolean;
    substituted: string | undefined;
  } {
    let alternatives = [''];
    let resolved = true;
    let substituted: string | undefined;
    // Set when something other than an environment variable is unknown.
    let other = false;
    const unknown = (env: boolean) => {
      resolved = false;
      if (!env) other = true;
    };
    // Only well-known roots from the user's environment that this command never sets.
    const isEnv = (name: string) =>
      ENV_ROOTS.has(name) && !scope.vars.has(name) && !this.touched.has(name);
    // True while the word is made only of unquoted expansions, which vanish when empty.
    let bare = true;
    const subPrograms: string[] = [];
    const append = (options: string[]) => {
      const next: string[] = [];
      for (const a of alternatives) for (const o of options) next.push(a + o);
      // Past the limit the remaining words are unknown, never silently dropped.
      if (next.length > MAX_ALTERNATIVES) unknown(false);
      alternatives = next.slice(0, MAX_ALTERNATIVES);
    };
    const expanded = (value: string | string[]) => {
      const options = Array.isArray(value) ? value : [value];
      if (quoted) return append(options);
      // A changed IFS splits words somewhere we do not follow. It can be changed in ways
      // the scope does not show (`IFS=x eval ...`, `printf -v IFS`), so any mention counts.
      if (scope.vars.has('IFS') || this.ifsMentioned) unknown(false);
      append(options.map((v) => v.replace(/[ \t\n]+/g, FIELD_BREAK)));
    };
    // A variable that branches left as one of a few known values. Normally it is
    // unknown like any other; with useChoices it expands to those values.
    let choice = false;
    let complete = true;
    const choicesOf = (name: string) => {
      const list = scope.vars.get(name) === null ? scope.choices.get(name) : undefined;
      if (list) {
        choice = true;
        if (!scope.exhaustive.has(name)) complete = false;
      }
      return useChoices ? list : undefined;
    };
    for (const part of parts) {
      // `"$@"` is one word per argument, and no word at all when there are none.
      if (part.type === 'DoubleQuoted' && scope.positional && isAllArguments(part)) {
        append([scope.positional.join(FIELD_BREAK)]);
        continue;
      }
      if (
        part.type !== 'SimpleExpansion' &&
        part.type !== 'ParameterExpansion' &&
        part.type !== 'CommandExpansion'
      )
        bare = false;
      switch (part.type) {
        case 'Literal':
        case 'SingleQuoted':
        case 'AnsiCQuoted':
          append([part.value]);
          break;
        case 'DoubleQuoted':
        case 'LocaleString': {
          const inner = this.evalParts(
            part.parts as readonly WordPart[],
            src,
            scope,
            ctx,
            true,
            useChoices,
          );
          if (!inner.resolved) unknown(inner.envOnly);
          if (inner.choice) choice = true;
          if (!inner.complete) complete = false;
          subPrograms.push(...inner.subPrograms);
          append(inner.alternatives);
          break;
        }
        case 'SimpleExpansion': {
          const name = part.text.slice(1);
          const v = this.lookup(name, scope) ?? choicesOf(name);
          if (v === undefined) {
            unknown(isEnv(name));
            append([part.text]);
          } else expanded(v);
          break;
        }
        case 'ParameterExpansion': {
          let v: string | string[] | undefined;
          if (!part.prefix && !part.index && !part.operation)
            v = this.lookup(part.parameter, scope) ?? choicesOf(part.parameter);
          else if (
            part.operation?.type === 'Default' &&
            (part.operation.operator === ':=' || part.operation.operator === '=')
          ) {
            // `${X:=value}` may set X: from here on it is not known.
            if (this.lookup(part.parameter, scope) === undefined)
              this.forget(scope, part.parameter);
          } else if (
            part.operation?.type === 'Default' &&
            (part.operation.operator === ':-' || part.operation.operator === '-')
          ) {
            v = this.lookup(part.parameter, scope) ?? choicesOf(part.parameter);
            // A variable known to hold something unknown (`X=$(cmd)`, `read X`) may
            // well be set, so its fallback says nothing about its value.
            if (v === undefined && !this.knownUnknown(part.parameter, scope)) {
              const fallback = this.evalWord(part.operation.operand, src, scope, ctx);
              subPrograms.push(...fallback.subPrograms);
              if (fallback.resolved) v = fallback.value;
            }
          }
          if (v === undefined) {
            const plain = !part.prefix && !part.index && !part.operation;
            unknown(plain && isEnv(part.parameter));
            append([part.text]);
          } else expanded(v);
          break;
        }
        case 'CommandExpansion':
        case 'ProcessSubstitution': {
          const before = this.out.length;
          let staticOut: string | undefined;
          if (part.script) {
            for (const err of part.script.errors ?? []) this.errors.push(err.message);
            const only = part.script.commands.length === 1 ? part.script.commands[0] : undefined;
            if (only) {
              // `$(echo .env)` is just `.env`, and `<(echo 'rm -rf ~')` holds that
              // text: evaluate simple output statically.
              staticOut = this.node(
                only.command,
                part.script.source ?? src,
                cloneScope(scope),
                ctx,
              ).stdout;
            } else {
              this.script(
                part.script,
                part.script.source ?? src,
                cloneScope(scope),
                ctx,
                undefined,
              );
            }
          }
          subPrograms.push(
            ...this.out
              .slice(before)
              .map((i) => i.program)
              .filter(Boolean),
          );
          if (part.type === 'ProcessSubstitution') {
            append(['/dev/fd/63']);
            if (parts.length === 1) substituted = staticOut;
          } else if (staticOut !== undefined) expanded(staticOut.replace(/\n+$/, ''));
          else {
            unknown(false);
            append([part.text]);
          }
          break;
        }
        case 'ArithmeticExpansion':
          this.substitutionsIn([part.expression], src, scope, ctx);
          unknown(false);
          append([part.text]);
          break;
        case 'BraceExpansion':
          append(expandBraces(part.text));
          break;
        case 'ExtendedGlob':
          append([part.text]);
          break;
      }
    }
    return {
      alternatives,
      resolved,
      subPrograms,
      bare,
      envOnly: !resolved && !other,
      choice,
      complete,
      substituted,
    };
  }

  /**
   * After a branch, keeps in `scope` only what every way through it agrees on. A folder
   * or variable that differs between them becomes unknown. Aliases and functions that
   * any of them defined are kept, so they are still checked.
   */
  private merge(scope: Scope, outcomes: Scope[]): void {
    const [first, ...rest] = outcomes;
    if (!first) return;
    // Where every way leads to a known folder or value, the few candidates are kept.
    this.setCwd(scope, outcomes.flatMap(folders));
    const names = new Set(outcomes.flatMap((o) => [...o.vars.keys()]));
    for (const name of names) {
      const value = first.vars.get(name);
      const agree = rest.every(
        (o) => o.vars.has(name) === first.vars.has(name) && o.vars.get(name) === value,
      );
      scope.choices.delete(name);
      scope.exhaustive.delete(name);
      if (agree && typeof value === 'string') scope.vars.set(name, value);
      else if (agree && !first.vars.has(name)) scope.vars.delete(name);
      else {
        // Unknown from here on. The known values any path left are kept as candidates,
        // which are only ever checked on the side (see probes): a path that leaves the
        // variable unset or unknown cannot hide `X=~` on another.
        scope.vars.set(name, null);
        const known = outcomes.flatMap((o) => {
          const v = o.vars.get(name);
          return typeof v === 'string' ? [v] : v === null ? (o.choices.get(name) ?? []) : [];
        });
        const all = [...new Set(known)];
        const set = all.slice(0, MAX_CHOICES);
        scope.exhaustive.delete(name);
        if (set.length > 0) scope.choices.set(name, set);
        // Complete when every path left a known value (or a complete list of them).
        if (
          set.length === all.length &&
          outcomes.every((o) => {
            const v = o.vars.get(name);
            return typeof v === 'string' || (v === null && o.exhaustive.has(name));
          })
        )
          scope.exhaustive.add(name);
      }
    }
    // A variable that became unknown may still name one program on every path.
    for (const name of names) {
      if (scope.vars.get(name) !== null) {
        scope.programs.delete(name);
        continue;
      }
      const program = (o: Scope) => {
        const v = o.vars.get(name);
        if (typeof v === 'string') return programName(v);
        const choices = o.choices.get(name)?.map(programName);
        if (choices && new Set(choices).size === 1) return choices[0];
        return o.programs.get(name);
      };
      const p = program(first);
      if (p && rest.every((o) => program(o) === p)) scope.programs.set(name, p);
      else scope.programs.delete(name);
    }
    const args = (o: Scope) => o.positional?.join('\0');
    if (first.positional && rest.every((o) => args(o) === args(first)))
      scope.positional = first.positional;
    else delete scope.positional;
    for (const o of outcomes) {
      for (const [k, v] of o.aliases) scope.aliases.set(k, v);
      for (const [k, defs] of o.functions) {
        const byBody = new Map<AnyNode, FunctionDef>();
        for (const d of [...(scope.functions.get(k) ?? []), ...defs]) byBody.set(d.body, d);
        scope.functions.set(k, [...byBody.values()]);
      }
    }
  }

  /**
   * A loop body runs any number of times, maybe none. It is checked once from the state
   * before the loop and once more from the state a first pass may leave, which catches
   * a value one pass sets for the next (`rm -rf "$X"; X=~`).
   */
  private loop(scope: Scope, run: (body: Scope) => void): void {
    this.loopExits.push([]);
    const once = cloneScope(scope);
    run(once);
    const before = cloneScope(scope);
    this.merge(scope, [before, once, ...this.loopExits.at(-1)!]);
    const twice = cloneScope(scope);
    run(twice);
    // `break` and `continue` leave the body early, with the state they had there.
    this.merge(scope, [before, once, twice, ...this.loopExits.pop()!]);
  }

  /** Checks trap code again with the functions defined by the end of the command. */
  finishTraps(): void {
    for (const t of this.traps.splice(0))
      this.codeString([t.code], t.text, t.scope, t.ctx, undefined);
  }

  /** The variable now holds something belayd does not know. */
  private forget(scope: Scope, name: string): void {
    scope.vars.set(name, null);
    scope.programs.delete(name);
    scope.choices.delete(name);
    scope.exhaustive.delete(name);
  }

  /** Sets the folder from its candidates: one known folder, a few, or unknown. */
  private setCwd(scope: Scope, candidates: (string | undefined)[]): void {
    const set = [...new Set(candidates)];
    delete scope.cwdChoices;
    delete scope.cwdExhaustive;
    if (set.length === 1) scope.cwd = set[0];
    else {
      // One of a few known folders, or unknown with some known ones to check on the side.
      scope.cwd = undefined;
      const known = set.filter((c): c is string => c !== undefined);
      if (known.length > 0) scope.cwdChoices = known.slice(0, MAX_CHOICES);
      if (known.length === set.length && known.length <= MAX_CHOICES) scope.cwdExhaustive = true;
    }
  }

  private assign(scope: Scope, name: string, value: EvalWord): void {
    scope.vars.set(name, value.resolved ? value.value : null);
    scope.choices.delete(name);
    scope.exhaustive.delete(name);
    // `Y=$X` keeps X's candidates: no word splitting happens in an assignment.
    if (!value.resolved && value.candidates) {
      scope.choices.set(
        name,
        value.candidates.map((fields) => fields.join(' ')),
      );
      if (value.exhaustive) scope.exhaustive.add(name);
    }
    const program = value.resolved ? undefined : envProgram(value);
    if (program) scope.programs.set(name, program);
    else scope.programs.delete(name);
  }

  /** The program an unknown command name certainly runs, if belayd can tell. */
  private programOf(head: EvalWord, scope: Scope): string | undefined {
    if (head.resolved) return undefined;
    const ref = /^"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?$/.exec(head.text);
    return envProgram(head) ?? (ref ? scope.programs.get(ref[1]!) : undefined);
  }

  private knownUnknown(name: string, scope: Scope): boolean {
    if (/^[1-9@*#]$/.test(name)) return !scope.positional;
    return scope.vars.has(name) && scope.vars.get(name) === null;
  }

  private lookup(name: string, scope: Scope): string | undefined {
    if (name === 'PWD') return scope.cwd;
    if (/^[1-9@*#]$/.test(name)) {
      const args = scope.positional;
      if (!args) return undefined;
      if (name === '#') return String(args.length);
      if (name === '@' || name === '*') return args.join(' ');
      return args[Number(name) - 1] ?? '';
    }
    const v = scope.vars.get(name);
    return v === null ? undefined : v;
  }

  /** Finds `$(...)` and `<(...)` anywhere inside an expression tree and analyses them. */
  private substitutionsIn(nodes: unknown[], src: string, scope: Scope, ctx: Ctx): void {
    const visit = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(visit);
      const node = n as { type?: string; script?: ParsedScript };
      if (
        (node.type === 'CommandExpansion' ||
          node.type === 'ProcessSubstitution' ||
          node.type === 'ArithmeticCommandExpansion') &&
        node.script
      ) {
        this.script(node.script, node.script.source ?? src, cloneScope(scope), ctx, undefined);
        return;
      }
      for (const [k, v] of Object.entries(node)) if (k !== 'script') visit(v);
    };
    nodes.forEach(visit);
  }

  private base(text: string, scope: Scope, ctx: Ctx): Invocation {
    return {
      argv: [],
      program: '',
      text,
      cwd: scope.cwd,
      ...(scope.cwd === undefined && scope.cwdChoices
        ? { cwdChoices: scope.cwdChoices, cwdExhaustive: scope.cwdExhaustive === true }
        : {}),
      dynamic: false,
      unresolved: false,
      redirects: [],
      codeFrom: [],
      inlineCode: false,
      via: ctx.via,
      remote: ctx.remote,
      stdin: undefined,
      scripts: [],
      ...(ctx.trusted ? { trusted: true } : {}),
    };
  }

  private pushDynamic(
    text: string,
    scope: Scope,
    ctx: Ctx,
    note: string,
    codeFrom: string[] = [],
  ): void {
    this.push({ ...this.base(text, scope, ctx), dynamic: true, unresolved: true, codeFrom, note });
  }

  private push(inv: Invocation): void {
    if (this.exhausted) return;
    this.out.push(inv);
    if (this.out.length > MAX_INVOCATIONS) this.exhaust(inv);
  }

  /**
   * Stops the analysis once it has seen too much, leaving one entry that belayd cannot
   * check, so the result is a question rather than a hang.
   */
  private exhaust(at: Invocation): void {
    if (this.exhausted) return;
    this.out.push({
      ...at,
      argv: [],
      program: '',
      dynamic: true,
      unresolved: true,
      note: 'too much code for belayd to check',
    });
    this.exhausted = true;
  }
}

function cloneScope(scope: Scope): Scope {
  return {
    vars: new Map(scope.vars),
    cwd: scope.cwd,
    aliases: new Map(scope.aliases),
    downloads: scope.downloads, // shared: a download in a subshell still lands on disk
    written: scope.written,
    contents: scope.contents,
    generated: scope.generated,
    functions: new Map(scope.functions),
    programs: new Map(scope.programs),
    choices: new Map(scope.choices),
    exhaustive: new Set(scope.exhaustive),
    ...(scope.cwdChoices ? { cwdChoices: scope.cwdChoices } : {}),
    ...(scope.cwdExhaustive ? { cwdExhaustive: true } : {}),
    ...(scope.positional ? { positional: scope.positional } : {}),
  };
}

function skipOptions(args: EvalWord[], valueOptions: Set<string> | undefined): EvalWord[] {
  let i = 0;
  for (; i < args.length; i++) {
    const v = args[i]!.value;
    if (v === '--') return args.slice(i + 1);
    if (!v.startsWith('-') || v === '-') break;
    if (valueOptions?.has(v)) i++;
  }
  return args.slice(i);
}

export function resolveIn(cwd: string | undefined, p: string, home: string): string | undefined {
  if (p === '~' || p.startsWith('~/')) return path.resolve(home, p.slice(2));
  if (p.startsWith('~')) return undefined; // ~otheruser
  if (path.isAbsolute(p)) return path.resolve(p);
  if (cwd === undefined) return undefined;
  return path.resolve(cwd, p);
}

function expandTilde(text: string, value: string, home: string): string {
  if (!text.startsWith('~')) return value;
  if (value === '~') return home;
  if (value.startsWith('~/')) return home + value.slice(1);
  return value;
}

function expandBraces(text: string): string[] {
  const inner = text.slice(1, -1);
  if (/^-?\w+\.\.-?\w+(\.\.-?\d+)?$/.test(inner)) return [text]; // ranges like {1..5}
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      items.push(current);
      current = '';
    } else current += ch;
  }
  items.push(current);
  return items.length > 1 ? items : [text];
}

function unescape(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The words one word becomes: `/{etc,usr}` expands to `/etc` and `/usr`, an unquoted
 * `$X` holding `rm -rf` to `rm` and `-rf`, and an empty unquoted `$X` to nothing.
 */
function expandWord(w: EvalWord): EvalWord[] {
  if (!w.fields && w.values.length <= 1) return [w];
  const words = w.fields ?? w.values.map((v) => [v]);
  return words.flat().map((value) => ({ ...w, value, values: [value], fields: undefined }));
}

/** Undo the escapes of a source-code string literal, enough to read a command or path. */
function unquote(s: string): string {
  return s.replace(/\\(["'\\\x60])/g, '$1').replace(/\\n/g, '\n');
}

function expandUser(p: string, home: string): string {
  return p === '~' || p.startsWith('~/') ? home + p.slice(1) : p;
}

function literal(value: string): EvalWord {
  return { text: value, value, values: [value], resolved: true, subPrograms: [] };
}

function unknownWord(text: string): EvalWord {
  return { text, value: text, values: [text], resolved: false, subPrograms: [] };
}

const SHELL_CALLS = [
  'system',
  'os.execute',
  'io.popen',
  'popen',
  'execSync',
  'exec',
  'spawnSync',
  'check_output',
  'check_call',
  'subprocess.run',
  'subprocess.call',
  'subprocess.Popen',
  'shell_exec',
  'passthru',
  'do shell script',
  'qx',
];
const REMOVE_CALLS = [
  'rmtree',
  'rmSync',
  'rmdirSync',
  'unlinkSync',
  'os.remove',
  'os.unlink',
  'os.rmdir',
  'promises.rm',
  'rimraf',
  'rimraf.sync',
  'unlink',
  'rm_rf',
  'File.delete',
];
const READ_CALLS = [
  'open',
  'readFileSync',
  'readFile',
  'File.read',
  'IO.read',
  'file_get_contents',
  'Path',
];

const callPatterns = new Map<readonly string[], RegExp>();

/**
 * The string literals passed to the named calls: `system("rm -rf ~")` gives `rm -rf ~`.
 * A plain scan rather than one big regex, so hostile input cannot make it backtrack:
 * each call name is found by a regex with no nested repetition, and its argument is
 * read character by character.
 */
function callArguments(code: string, names: readonly string[], needParen: boolean): string[] {
  let re = callPatterns.get(names);
  if (!re) {
    const alternatives = names.map((n) => n.replace(/[.]/g, '\\.'));
    re = new RegExp(`(?<![A-Za-z0-9_$])(?:${alternatives.join('|')})(?![A-Za-z0-9_$])`, 'g');
    callPatterns.set(names, re);
  }
  const found: string[] = [];
  re.lastIndex = 0;
  let scanned = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let i = m.index + m[0].length;
    while (code[i] === ' ' || code[i] === '\t') i++;
    if (code[i] === '(') i++;
    else if (needParen) continue;
    while (code[i] === ' ' || code[i] === '\t') i++;
    const quote = code[i];
    if (quote !== '"' && quote !== "'" && quote !== '`') continue;
    const start = i + 1;
    let end = -1;
    for (let j = start; j < code.length && j - start < MAX_LITERAL; j++) {
      const c = code[j];
      if (c === '\\') j++;
      else if (c === quote) {
        end = j;
        break;
      } else if (c === '\n' && quote !== '`') break;
    }
    scanned += (end < 0 ? Math.min(MAX_LITERAL, code.length - start) : end - start) + 1;
    if (scanned > MAX_INLINE_CODE * 4) break;
    if (end < 0) continue;
    found.push(code.slice(start, end));
    re.lastIndex = end + 1;
  }
  return found;
}

/** Calls that take the command as a list of words: Python's subprocess, Node's spawn. */
const ARGV_CALLS = [
  'subprocess.run',
  'subprocess.call',
  'subprocess.Popen',
  'subprocess.check_output',
  'subprocess.check_call',
  'check_output',
  'check_call',
  'Popen',
  'run',
  'call',
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'execa',
  'execaSync',
  'Bun.spawn',
  'Bun.spawnSync',
  'IO.popen',
  'Process.spawn',
];
/** Ruby and Perl also take the words as separate arguments: `system("rm", "-rf", dir)`. */
const VARARG_CALLS = [...ARGV_CALLS, 'system', 'exec'];

const argPatterns = new Map<readonly string[], RegExp>();

type CallArg =
  | { kind: 'string'; value: string }
  | { kind: 'list'; items: (string | undefined)[] }
  | { kind: 'other' };

/**
 * The arguments of each call to one of `names`: plain strings, lists of plain strings
 * (`undefined` for an element that is anything else), or something else. One pass over
 * the code, like callArguments, so a hostile script cannot make it slow.
 */
function callArgs(code: string, names: readonly string[]): CallArg[][] {
  // `x.run(...)` matches too: only list-shaped arguments ever become a command.
  let re = argPatterns.get(names);
  if (!re) {
    const alternatives = names.map((n) => n.replace(/[.]/g, '\\.'));
    re = new RegExp(`(?<![A-Za-z0-9_$])(?:${alternatives.join('|')})(?![A-Za-z0-9_$])`, 'g');
    argPatterns.set(names, re);
  }
  const out: CallArg[][] = [];
  const space = (i: number) => {
    while (i < code.length && /\s/.test(code[i]!)) i++;
    return i;
  };
  /** A quoted string at i, without interpolation. */
  const str = (i: number): { value: string; end: number } | undefined => {
    const quote = code[i];
    if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
    for (let j = i + 1; j < code.length && j - i < MAX_LITERAL; j++) {
      const c = code[j];
      if (c === '\\') j++;
      else if (quote === '`' && c === '$' && code[j + 1] === '{') return undefined;
      else if (c === quote) return { value: unquote(code.slice(i + 1, j)), end: j + 1 };
      else if (c === '\n' && quote !== '`') return undefined;
    }
    return undefined;
  };
  /** Skips one expression up to a top-level `,` or the closing bracket. */
  const skip = (i: number, close: string) => {
    let depth = 0;
    for (; i < code.length; i++) {
      const c = code[i]!;
      if (depth === 0 && (c === ',' || c === close)) return i;
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === '"' || c === "'" || c === '`') {
        const s = str(i);
        if (s) i = s.end - 1;
      }
    }
    return i;
  };
  let scanned = 0;
  re.lastIndex = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let i = space(m.index + m[0].length);
    if (code[i] !== '(') continue;
    const start = i;
    i = space(i + 1);
    const args: CallArg[] = [];
    while (i < code.length && code[i] !== ')') {
      const s = str(i);
      let next: number;
      if (s && /^\s*[,)]/.test(code.slice(s.end, s.end + 40))) {
        args.push({ kind: 'string', value: s.value });
        next = s.end;
      } else if (code[i] === '[') {
        const items: (string | undefined)[] = [];
        let j = space(i + 1);
        while (j < code.length && code[j] !== ']') {
          const e = str(j);
          if (e && /^\s*[,\]]/.test(code.slice(e.end, e.end + 40))) {
            items.push(e.value);
            j = e.end;
          } else {
            items.push(undefined);
            j = skip(j, ']');
          }
          j = space(j);
          if (code[j] === ',') j = space(j + 1);
          else break;
        }
        args.push({ kind: 'list', items });
        next = code[j] === ']' ? j + 1 : j;
      } else {
        args.push({ kind: 'other' });
        next = skip(i, ')');
      }
      i = space(next);
      if (code[i] === ',') i = space(i + 1);
      else break;
    }
    scanned += i - start;
    if (scanned > MAX_INLINE_CODE * 4) break;
    if (args.length > 0) out.push(args);
    re.lastIndex = Math.max(i, m.index + m[0].length);
  }
  return out;
}

/** True for `"$@"` and `"${@}"`. */
function isAllArguments(part: WordPart): boolean {
  const inner = (part as { parts?: readonly WordPart[] }).parts;
  if (inner?.length !== 1) return false;
  const only = inner[0]!;
  return (
    (only.type === 'SimpleExpansion' && only.text === '$@') ||
    (only.type === 'ParameterExpansion' &&
      only.parameter === '@' &&
      !only.prefix &&
      !only.index &&
      !only.operation)
  );
}

const TEXT_TOOLS = new Set(['printf', 'echo', 'xargs', 'sed', 'tr']);
/** The sed script in Gradle's wrapper that backslash-escapes every character a shell treats specially. */
const GRADLE_ESCAPE = 's~[^-[:alnum:]+,./:=@_]~\\\\&~g';

/**
 * Wrapper scripts such as gradlew rebuild their arguments with
 * `eval "set -- $(printf '%s\n' "$JAVA_OPTS" | xargs -n1 | sed '...' | tr '\n' ' ')" '"$@"'`.
 * The sed step escapes every special character, so the eval can only reset the
 * arguments. Only that exact shape counts, and only in scripts read from disk, never
 * in a command typed by the agent. When the output is known, the eval is checked as
 * usual instead.
 */
function resetsArguments(args: EvalWord[]): boolean {
  const [first, ...rest] = args;
  if (!first || first.resolved) return false;
  const text = first.text;
  if (!text.startsWith('"set -- $(') || !text.endsWith(')"')) return false;
  if (text.indexOf('$(') !== 8 || text.lastIndexOf(')') !== text.length - 2) return false;
  if (!text.includes(GRADLE_ESCAPE)) return false;
  if (!first.subPrograms.every((p) => TEXT_TOOLS.has(p))) return false;
  return rest.length <= 1 && rest.every((w) => w.text === `'"$@"'`);
}

/**
 * The shell commands an awk program runs: `system("cmd")`, `"cmd" | getline` and
 * `print | "cmd"`. Undefined when one of them is built at run time, has escapes, pipes
 * into a shell, or the program cannot be read, since belayd cannot know that command.
 * One pass marks strings, regex literals and comments, then plain index lookups, so
 * the time stays linear in the program size.
 */
function awkCommands(code: string): string[] | undefined {
  const byStart = new Map<number, { body: string; end: number }>();
  const byEnd = new Map<number, { body: string; end: number }>();
  // 1 inside a string, regex literal or comment.
  const quoted = new Uint8Array(code.length);
  // The last character that was not space, to tell a regex `/re/` from a division.
  let prev = '\n';
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== '"' && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      if (code[j] !== '"') return undefined;
      const lit = { body: code.slice(i + 1, j), end: j + 1 };
      byStart.set(i, lit);
      byEnd.set(j + 1, lit);
      quoted.fill(1, i, j + 1);
      i = j;
      prev = '"';
    } else if (c === '/' && '\n(,~!{};&|=?:'.includes(prev)) {
      let j = i + 1;
      while (j < code.length && code[j] !== '/' && code[j] !== '\n') {
        if (code[j] === '\\') j += 2;
        else if (code[j] === '[') {
          // A bracket expression may hold `/` or `"`: skip to its closing `]`.
          j += code[j + 1] === ']' ? 2 : code[j + 1] === '^' && code[j + 2] === ']' ? 3 : 1;
          while (j < code.length && code[j] !== ']' && code[j] !== '\n') j++;
          j++;
        } else j++;
      }
      if (code[j] !== '/') return undefined;
      quoted.fill(1, i, j + 1);
      i = j;
      prev = '/';
    } else if (c === '#') {
      let j = i;
      while (j < code.length && code[j] !== '\n') j++;
      quoted.fill(1, i, j);
      i = j - 1;
    } else if (c !== ' ' && c !== '\t') prev = c;
  }
  const skip = (p: number, step: 1 | -1) => {
    while (code[p] === ' ' || code[p] === '\t') p += step;
    return p;
  };
  const plain = (lit: { body: string } | undefined) =>
    lit && !lit.body.includes('\\') ? lit.body : undefined;
  const out: string[] = [];

  // Never skipped as quoted text: a misread quote must not hide a real call.
  for (const m of code.matchAll(/(?<![A-Za-z0-9_])system[ \t]*\(/g)) {
    const lit = byStart.get(skip(m.index + m[0].length, 1));
    const body = plain(lit);
    if (body === undefined || code[skip(lit!.end, 1)] !== ')') return undefined;
    out.push(body);
  }
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '|' || quoted[i] || code[i + 1] === '|' || code[i - 1] === '|') continue;
    let after = i + 1;
    if (code[after] === '&') after++;
    after = skip(after, 1);
    if (code.startsWith('getline', after)) {
      const body = plain(byEnd.get(skip(i - 1, -1) + 1));
      if (body === undefined) return undefined;
      out.push(body);
      continue;
    }
    const target = byStart.get(after);
    if (target) {
      const body = plain(target);
      if (body === undefined || /^\s*(\S*\/)?(ba|z|da|k|fi)?sh(\s|$)/.test(body)) return undefined;
      out.push(body);
      continue;
    }
    // `print | cmd` with cmd in a variable: the command is not known.
    let start = i;
    const floor = Math.max(0, i - 1000);
    while (start > floor && !';{}\n'.includes(code[start - 1]!)) start--;
    if (/\bprintf?\b/.test(code.slice(start, i))) return undefined;
  }
  return out;
}

/** The arguments after getopt-style options, where `valueLetters` take a value. */
function getoptPositionals(args: EvalWord[], valueLetters: string): EvalWord[] {
  const out: EvalWord[] = [];
  for (let i = 0; i < args.length; i++) {
    const v = args[i]!.value;
    if (v === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    // Options end at the first other word, like getopt in tmux: `new -d rm -rf ~`
    // runs `rm -rf ~`, and its `-rf` is not read as tmux options.
    if (!v.startsWith('-') || v === '-') {
      out.push(...args.slice(i));
      break;
    }
    // `-dsx` is three flags; `-sname` is -s with its value; `-ds name` takes the next word.
    for (let k = 1; k < v.length; k++) {
      if (!valueLetters.includes(v[k]!)) continue;
      if (k === v.length - 1) i++;
      break;
    }
  }
  return out;
}

/**
 * The program a word names when it is unknown only because of environment variables,
 * like `$JAVA_HOME/bin/java`: the user's environment decides the folder, not the agent.
 */
function envProgram(word: EvalWord): string | undefined {
  if (!word.envOnly) return undefined;
  const name = programName(word.value);
  // A glob like `r?` could match another program.
  return name && !/[$`{}*?[\]]/.test(name) ? name : undefined;
}

/**
 * Concrete word lists for each combination of candidate values, up to MAX_CHOICES of
 * them. A word without candidates is used as it is.
 */
function probes(slots: EvalWord[][]): { combos: EvalWord[][]; complete: boolean } {
  let combos: EvalWord[][] = [[]];
  let complete = true;
  for (const slot of slots) {
    const word = slot.length === 1 ? slot[0]! : undefined;
    const options: EvalWord[][] = word?.candidates
      ? word.candidates.map((fields) => fields.map(literal))
      : [slot];
    const next: EvalWord[][] = [];
    for (const combo of combos) for (const option of options) next.push([...combo, ...option]);
    if (next.length > MAX_CHOICES) complete = false;
    combos = next.slice(0, MAX_CHOICES);
  }
  return { combos: combos.filter((c) => c.length > 0), complete };
}

/** The folders a scope may be in; undefined stands for one belayd cannot tell. */
function folders(scope: Scope): (string | undefined)[] {
  if (scope.cwd !== undefined) return [scope.cwd];
  return [...(scope.cwdChoices ?? []), ...(scope.cwdExhaustive ? [] : [undefined])];
}
