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
}

export interface Invocation {
  argv: string[];
  /** Basename of argv[0]. Empty for a statement that is only a redirect (`> file`). */
  program: string;
  /** Source text of the command this invocation came from. */
  text: string;
  /** Working directory, or undefined when an earlier `cd` made it unknowable. */
  cwd: string | undefined;
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
  /** Human readable note for dynamic invocations. */
  note?: string;
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
}

const MAX_DEPTH = 6;
const MAX_ALTERNATIVES = 64;

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
  deno: { inline: ['eval'] },
  perl: { inline: ['-e', '-E'] },
  ruby: { inline: ['-e'] },
  php: { inline: ['-r'] },
  lua: { inline: ['-e'] },
  osascript: { inline: ['-e'] },
  pwsh: { inline: ['-c', '-command', '-encodedcommand', '-ec'] },
  powershell: { inline: ['-c', '-command', '-encodedcommand', '-ec'] },
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
]);

const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx']);

interface EvalWord {
  text: string;
  value: string;
  values: string[];
  resolved: boolean;
  /** Programs run inside `$(...)` or `<(...)` within this word. */
  subPrograms: string[];
}

interface Scope {
  vars: Map<string, string | null>;
  cwd: string | undefined;
  aliases: Map<string, string>;
  /** Files written by network fetchers in this script (`curl -o x.sh`). */
  downloads: Map<string, string>;
}

interface Ctx {
  depth: number;
  via: string[];
  remote: boolean;
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
  };
  analyzer.source(command, scope, { depth: 0, via: [], remote: false }, undefined);
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

  source(src: string, scope: Scope, ctx: Ctx, stdin: StdinInfo | undefined): void {
    if (ctx.depth > MAX_DEPTH) {
      this.pushDynamic(src, scope, ctx, 'nested too deeply to analyse');
      return;
    }
    const ast = parse(src);
    for (const err of ast.errors ?? []) this.errors.push(err.message);
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
    for (const st of list) this.node(st.command, src, scope, ctx, stdin);
  }

  private compoundList(list: CompoundList, src: string, scope: Scope, ctx: Ctx): void {
    this.statements(list.commands, src, scope, ctx);
  }

  /** Returns information about what the node writes to stdout, for pipelines. */
  private node(n: AnyNode, src: string, scope: Scope, ctx: Ctx, stdin?: StdinInfo): StageResult {
    const before = this.out.length;
    let stdout: string | undefined;
    switch (n.type) {
      case 'AndOr':
        for (const c of n.commands) this.node(c, src, scope, ctx);
        break;
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
      case 'If':
        this.compoundList(n.clause, src, scope, ctx);
        this.compoundList(n.then, src, scope, ctx);
        if (n.else) this.node(n.else, src, scope, ctx);
        break;
      case 'For':
      case 'Select':
        for (const w of n.wordlist ?? []) this.evalWord(w, src, scope, ctx);
        scope.vars.set(n.name.value, null);
        this.compoundList(n.body, src, scope, ctx);
        break;
      case 'ArithmeticFor':
        this.substitutionsIn([n.initialize, n.test, n.update], src, scope, ctx);
        this.compoundList(n.body, src, scope, ctx);
        break;
      case 'While':
        this.compoundList(n.clause, src, scope, ctx);
        this.compoundList(n.body, src, scope, ctx);
        break;
      case 'Case':
        this.evalWord(n.word, src, scope, ctx);
        for (const item of n.items) this.compoundList(item.body, src, scope, ctx);
        break;
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
      case 'Function':
        // Analyse the body where it is defined. Calling it later is then harmless.
        this.node(n.body, src, cloneScope(scope), ctx);
        break;
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
    for (const stage of p.commands) {
      // Every stage of a pipeline runs in its own subshell.
      const result = this.node(stage, src, cloneScope(scope), ctx, {
        producers: [...producers],
        text: previous,
      });
      producers.push(...result.programs);
      previous = result.stdout;
    }
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
    if (cmd.name) words.push(this.evalWord(cmd.name, src, scope, ctx));
    const assignments: { name: string; value: EvalWord }[] = [];
    for (const arg of cmd.args) {
      if (arg.type === 'Word')
        words.push(...splitAlternatives(this.evalWord(arg, src, scope, ctx)));
      else {
        const value = this.evalAssignment(arg, src, scope, ctx);
        words.push({ ...value, value: `${arg.name}=${value.value}`, text: arg.text });
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
    const { redirects, inline } = this.redirects(cmd.redirects, src, scope, ctx);

    if (words.length === 0) {
      // A bare assignment (`X=rm`) updates the scope. A bare redirect truncates a file.
      for (const a of prefixAssignments)
        scope.vars.set(a.name, a.value.resolved ? a.value.value : null);
      if (redirects.length > 0) this.push({ ...this.base(text, scope, ctx), redirects });
      return undefined;
    }

    const effectiveStdin: StdinInfo | undefined =
      inline !== undefined ? { producers: [], text: inline } : stdin;
    const program = this.invoke(words, text, scope, ctx, effectiveStdin, redirects);

    // Track state that later commands depend on.
    switch (program) {
      case 'cd':
      case 'pushd': {
        const target = words.slice(1).find((w) => !w.value.startsWith('-'));
        if (!target) scope.cwd = this.opts.home;
        else if (!target.resolved) scope.cwd = undefined;
        else scope.cwd = resolveIn(scope.cwd, target.value, this.opts.home);
        break;
      }
      case 'popd':
        scope.cwd = undefined;
        break;
      case 'export':
      case 'declare':
      case 'typeset':
      case 'local':
      case 'readonly':
        for (const a of assignments)
          scope.vars.set(a.name, a.value.resolved ? a.value.value : null);
        break;
      case 'unset':
        for (const w of words.slice(1)) scope.vars.delete(w.value);
        break;
      case 'read':
      case 'mapfile':
      case 'readarray':
        for (const w of words.slice(1)) if (!w.value.startsWith('-')) scope.vars.set(w.value, null);
        break;
      case 'alias':
        for (const a of assignments) if (a.value.resolved) scope.aliases.set(a.name, a.value.value);
        for (const w of words.slice(1)) {
          const m = /^([^=\s]+)=(.*)$/s.exec(w.value);
          if (m && w.resolved) scope.aliases.set(m[1]!, m[2]!);
        }
        break;
    }
    return this.staticStdout(program, words, effectiveStdin);
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
    if (!head.resolved) {
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

    const program = programName(head.value);

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
    if (head.value.includes('/')) {
      const executed = resolveIn(scope.cwd, head.value, this.opts.home);
      const downloader = executed ? scope.downloads.get(executed) : undefined;
      if (downloader) inv.codeFrom = [downloader];
    }
    this.push(inv);
    this.trackDownloads(program, args, redirects, scope);

    const nested = (via: string): Ctx => ({ ...ctx, depth: ctx.depth + 1, via: [...ctx.via, via] });

    if (PASSTHROUGH.has(program)) {
      if (program === 'command' && args.some((w) => w.value === '-v' || w.value === '-V'))
        return program;
      let rest = skipOptions(args, VALUE_OPTIONS[program]);
      if (program === 'timeout') rest = rest.slice(1); // the duration
      if (rest.length > 0) this.invoke(rest, text, scope, nested(program), stdin, []);
      return program;
    }

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
        if (rest.length > 0) this.invoke(rest, text, scope, nested('env'), stdin, []);
        return program;
      }
      case 'xargs': {
        const rest = skipOptions(args, VALUE_OPTIONS.xargs);
        const inner = rest.length > 0 ? rest : [literal('echo')];
        this.invoke(
          [...inner, unknownWord('<items from stdin>')],
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
        this.codeString(args, text, scope, nested('eval'), stdin);
        return program;
      case 'source':
      case '.': {
        const file = args[0];
        if (file) inv.codeFrom = this.codeSources(file, scope);
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

    const interp = INTERPRETERS[program.replace(/[\d.]+$/, '')] ?? INTERPRETERS[program];
    if (interp) {
      const lower = args.map((w) => w.value.toLowerCase());
      if (lower.some((a) => interp.inline.includes(a))) {
        inv.inlineCode = true;
        for (const w of args) inv.codeFrom.push(...w.subPrograms);
      } else if (!lower.some((a) => interp.module?.includes(a))) {
        const script = args.find((w) => !w.value.startsWith('-'));
        if (script) inv.codeFrom.push(...this.codeSources(script, scope));
        else this.stdinCode(inv, stdin, scope, ctx, false);
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
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(v)) commandMode = true;
      else if (/^-[A-Za-z]*s[A-Za-z]*$/.test(v)) stdinMode = true;
      else if (v === '-o' || v === '+o' || v === '-O' || v === '+O') i++;
      else if (!v.startsWith('-') && !v.startsWith('+')) break;
    }
    const first = args[i];
    if (commandMode) {
      if (first) this.codeString([first], text, scope, ctx, stdin);
      return;
    }
    // `sh -s args...` reads its code from stdin and treats the rest as arguments.
    if (first && !stdinMode) {
      inv.codeFrom.push(...this.codeSources(first, scope));
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
      [{ ...pkg, value: path.posix.basename(bin) }, ...rest.slice(1)],
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
  ): string | undefined {
    const args = words.slice(1);
    if (!args.every((w) => w.resolved)) return undefined;
    switch (program) {
      case 'echo': {
        const rest = args.filter((w, i) => !(i === 0 && /^-[neE]+$/.test(w.value)));
        return rest.map((w) => w.value).join(' ') + '\n';
      }
      case 'printf': {
        const [fmt, ...rest] = args.map((w) => w.value);
        if (fmt === undefined) return undefined;
        if (!fmt.includes('%')) return unescape(fmt);
        if (fmt === '%s' || fmt === '%s\\n') return rest.join('') + (fmt.endsWith('n') ? '\n' : '');
        return undefined;
      }
      case 'cat':
      case 'tee':
        if (program === 'cat' && args.some((w) => w.value !== '-')) return undefined;
        return stdin?.text;
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
  ): { redirects: Redirect[]; inline: string | undefined } {
    const redirects: Redirect[] = [];
    let inline: string | undefined;
    for (const r of list) {
      if (r.type === 'HereDoc') {
        if (r.body.parts) this.evalParts(r.body.parts, src, scope, ctx);
        inline ??= r.body.text;
      } else if (r.type === 'HereString') {
        if (r.target) inline ??= this.evalWord(r.target, src, scope, ctx).value + '\n';
      } else if (r.target) {
        const target = this.evalWord(r.target, src, scope, ctx);
        // `>&2` and `2>&1` duplicate file descriptors; they are not files.
        if ((r.operator === '>&' || r.operator === '<&') && /^(\d+|-)$/.test(target.value))
          continue;
        redirects.push({ op: r.operator, target: target.value, resolved: target.resolved });
      }
    }
    return { redirects, inline };
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
      return { text: word.text, value, values: [value], resolved: true, subPrograms: [] };
    }
    const r = this.evalParts(word.parts, src, scope, ctx);
    const values = r.alternatives.map((v) =>
      word.text.startsWith('~') ? expandTilde(word.text, v, this.opts.home) : v,
    );
    return {
      text: word.text,
      value: values[0] ?? '',
      values,
      resolved: r.resolved,
      subPrograms: r.subPrograms,
    };
  }

  private evalParts(
    parts: readonly WordPart[],
    src: string,
    scope: Scope,
    ctx: Ctx,
  ): { alternatives: string[]; resolved: boolean; subPrograms: string[] } {
    let alternatives = [''];
    let resolved = true;
    const subPrograms: string[] = [];
    const append = (options: string[]) => {
      const next: string[] = [];
      for (const a of alternatives) for (const o of options) next.push(a + o);
      alternatives = next.slice(0, MAX_ALTERNATIVES);
    };
    for (const part of parts) {
      switch (part.type) {
        case 'Literal':
        case 'SingleQuoted':
        case 'AnsiCQuoted':
          append([part.value]);
          break;
        case 'DoubleQuoted':
        case 'LocaleString': {
          const inner = this.evalParts(part.parts as readonly WordPart[], src, scope, ctx);
          resolved &&= inner.resolved;
          subPrograms.push(...inner.subPrograms);
          append([inner.alternatives[0] ?? '']);
          break;
        }
        case 'SimpleExpansion': {
          const v = this.lookup(part.text.slice(1), scope);
          if (v === undefined) {
            resolved = false;
            append([part.text]);
          } else append([v]);
          break;
        }
        case 'ParameterExpansion': {
          let v: string | undefined;
          if (!part.prefix && !part.index && !part.operation)
            v = this.lookup(part.parameter, scope);
          else if (
            part.operation?.type === 'Default' &&
            (part.operation.operator === ':-' || part.operation.operator === '-')
          ) {
            v = this.lookup(part.parameter, scope);
            if (v === undefined) {
              const fallback = this.evalWord(part.operation.operand, src, scope, ctx);
              subPrograms.push(...fallback.subPrograms);
              if (fallback.resolved) v = fallback.value;
            }
          }
          if (v === undefined) {
            resolved = false;
            append([part.text]);
          } else append([v]);
          break;
        }
        case 'CommandExpansion':
        case 'ProcessSubstitution': {
          const before = this.out.length;
          if (part.script) {
            for (const err of part.script.errors ?? []) this.errors.push(err.message);
            this.script(part.script, part.script.source ?? src, cloneScope(scope), ctx, undefined);
          }
          subPrograms.push(
            ...this.out
              .slice(before)
              .map((i) => i.program)
              .filter(Boolean),
          );
          if (part.type === 'ProcessSubstitution') append(['/dev/fd/63']);
          else {
            resolved = false;
            append([part.text]);
          }
          break;
        }
        case 'ArithmeticExpansion':
          this.substitutionsIn([part.expression], src, scope, ctx);
          resolved = false;
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
    return { alternatives, resolved, subPrograms };
  }

  private lookup(name: string, scope: Scope): string | undefined {
    if (name === 'PWD') return scope.cwd;
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
      dynamic: false,
      unresolved: false,
      redirects: [],
      codeFrom: [],
      inlineCode: false,
      via: ctx.via,
      remote: ctx.remote,
      stdin: undefined,
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
    this.out.push(inv);
  }
}

function cloneScope(scope: Scope): Scope {
  return {
    vars: new Map(scope.vars),
    cwd: scope.cwd,
    aliases: new Map(scope.aliases),
    downloads: scope.downloads, // shared: a download in a subshell still lands on disk
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

/** `/{etc,usr}` expands to two words, `/etc` and `/usr`. */
function splitAlternatives(w: EvalWord): EvalWord[] {
  if (w.values.length <= 1) return [w];
  return w.values.map((value) => ({ ...w, value, values: [value] }));
}

function literal(value: string): EvalWord {
  return { text: value, value, values: [value], resolved: true, subPrograms: [] };
}

function unknownWord(text: string): EvalWord {
  return { text, value: text, values: [text], resolved: false, subPrograms: [] };
}
