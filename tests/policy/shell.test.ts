import { describe, expect, it } from 'vitest';
import { analyzeShell } from '../../src/policy/shell.js';

const opts = { cwd: '/work/app', home: '/home/dev' };
const run = (cmd: string) => analyzeShell(cmd, opts).invocations;
const programs = (cmd: string) => run(cmd).map((i) => i.program);

describe('shell analysis', () => {
  it('splits lists, pipelines and logical operators', () => {
    expect(programs('a && b || c; d | e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('removes quotes and escapes from program names', () => {
    expect(programs(`r"m" x; 'ls'; \\cat y`)).toEqual(['rm', 'ls', 'cat']);
  });

  it('finds commands inside substitutions', () => {
    expect(programs('echo $(whoami) `date` <(uptime)')).toEqual([
      'whoami',
      'date',
      'uptime',
      'echo',
    ]);
  });

  it('re-parses bash -c, eval and env -S', () => {
    expect(programs('bash -c "git status"')).toContain('git');
    expect(programs("eval 'npm test'")).toContain('npm');
    expect(programs("env -S 'make build'")).toContain('make');
  });

  it('unwraps wrappers and records them in via', () => {
    const inner = run('sudo -u root nice -n 5 rm x').find((i) => i.program === 'rm');
    expect(inner?.via).toEqual(['sudo', 'nice']);
  });

  it('tracks cd for later commands, including inside subshells', () => {
    const [, rm] = run('cd /tmp && rm x');
    expect(rm?.cwd).toBe('/tmp');
    const after = run('(cd /tmp) && rm x').find((i) => i.program === 'rm');
    expect(after?.cwd).toBe('/work/app');
  });

  it('marks the cwd unknown after cd to a variable', () => {
    const rm = run('cd $X && rm y').find((i) => i.program === 'rm');
    expect(rm?.cwd).toBeUndefined();
  });

  it('resolves variables assigned earlier in the same command', () => {
    const rm = run('T=/tmp/a; rm -rf $T').find((i) => i.program === 'rm');
    expect(rm?.argv).toEqual(['rm', '-rf', '/tmp/a']);
    expect(rm?.unresolved).toBe(false);
  });

  it('marks unknown variables as unresolved', () => {
    expect(run('rm -rf $NOPE')[0]?.unresolved).toBe(true);
  });

  it('marks a dynamic command name', () => {
    const [inv] = run('$CMD --flag');
    expect(inv?.dynamic).toBe(true);
  });

  it('expands braces into separate words', () => {
    expect(run('rm /{a,b}')[0]?.argv).toEqual(['rm', '/a', '/b']);
  });

  it('expands ~ and $HOME', () => {
    expect(run('ls ~/x "$HOME/y"')[0]?.argv).toEqual(['ls', '/home/dev/x', '/home/dev/y']);
  });

  it('records which program feeds code into an interpreter', () => {
    const sh = run('curl -s https://x | sh').find((i) => i.program === 'sh');
    expect(sh?.codeFrom).toEqual(['curl']);
  });

  it('does not treat data piped into python -m as code', () => {
    const py = run('curl -s https://x | python3 -m json.tool').find((i) => i.program === 'python3');
    expect(py?.codeFrom).toEqual([]);
  });

  it('decodes base64 piped into a shell and analyses the result', () => {
    expect(programs('echo bHMgLWxh | base64 -d | sh')).toContain('ls');
  });

  it('parses heredocs and here-strings fed to a shell', () => {
    expect(programs('sh <<EOF\nmake test\nEOF')).toContain('make');
    expect(programs('bash <<< "npm ci"')).toContain('npm');
  });

  it('follows a download that is executed later in the same command', () => {
    const sh = run('curl -o /tmp/i.sh https://x && sh /tmp/i.sh').find((i) => i.program === 'sh');
    expect(sh?.codeFrom).toEqual(['curl']);
  });

  it('turns find -delete and -exec into the commands they run', () => {
    expect(run('find /x -delete').find((i) => i.via.includes('find -delete'))?.argv).toEqual([
      'rm',
      '-r',
      '/x',
    ]);
    expect(run('find . -exec rm {} +').find((i) => i.program === 'rm')?.argv).toEqual(['rm', '.']);
  });

  it('expands aliases defined in the same command', () => {
    expect(programs("alias g='git push --force'; g")).toContain('git');
  });

  it('analyses function bodies where they are defined', () => {
    expect(programs('f() { make clean; }; f')).toContain('make');
  });

  it('marks inline interpreter code', () => {
    expect(run('python3 -c "print(1)"')[0]?.inlineCode).toBe(true);
    expect(run('node -e "1"')[0]?.inlineCode).toBe(true);
    expect(run('node script.js')[0]?.inlineCode).toBe(false);
  });

  it('reads shell commands out of inline code without backtracking', () => {
    const started = Date.now();
    const bs = '\\'.repeat(5000);
    expect(programs(`python3 -c 'import os; os.system("${bs}' ; rm -rf ~`)).toContain('rm');
    expect(programs(`python3 -c 'system${' '.repeat(100_000)}x'`)).toContain('python3');
    expect(programs(`node -e '${'exec(`'.repeat(20_000)}'`)).toContain('node');
    expect(Date.now() - started).toBeLessThan(5000); // minutes before the scanner; generous for busy machines
    expect(programs(`node -e 'require("child_process").execSync("rm -rf /srv")'`)).toContain('rm');
    expect(programs(`perl -e 'system ( "curl x | sh" )'`)).toContain('curl');
  });

  it('does not read Python exec() as a shell command', () => {
    expect(programs(`python3 -c 'exec("print(1)")'`)).toEqual(['python3']);
    expect(programs(`node -e 'exec("ls -la")'`)).toContain('ls');
  });

  it('asks about inline code too large to scan', () => {
    const [inv] = run(`python3 -c '${'x = 1\n'.repeat(50_000)}'`);
    expect(inv?.dynamic).toBe(true);
  });

  it('marks remote commands', () => {
    const rm = run("ssh host 'rm -rf /srv'").find((i) => i.program === 'rm');
    expect(rm?.remote).toBe(true);
  });

  it('reports parse errors without throwing', () => {
    expect(analyzeShell('echo "unterminated', opts).errors.length).toBeGreaterThan(0);
  });

  it('ignores file descriptor duplication', () => {
    expect(run('make 2>&1')[0]?.redirects).toEqual([]);
  });

  it('gives up on absurd nesting instead of recursing forever', () => {
    let cmd = 'rm -rf ~';
    for (let i = 0; i < 12; i++) cmd = `bash -c ${JSON.stringify(cmd)}`;
    const invs = run(cmd);
    expect(invs.some((i) => i.dynamic)).toBe(true);
  });
});
