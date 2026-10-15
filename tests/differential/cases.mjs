// The commands for the differential test: every shell row of the policy corpus, plus
// four dangerous actions hidden in many ways. Each case is checked against what bash
// really does with it.

/** Dangerous actions, each split into program and arguments so they can be hidden. */
const ACTIONS = [
  { id: 'delete-home-folder', program: 'rm', args: ['-rf', '~/precious'] },
  { id: 'read-env', program: 'cat', args: ['.env'] },
  { id: 'read-ssh-key', program: 'cat', args: ['~/.ssh/id_rsa'] },
  { id: 'append-bashrc', program: 'tee', args: ['-a', '~/.bashrc'], stdin: 'echo pwned |' },
];

const b64 = (s) => Buffer.from(s).toString('base64');
const hex = (s) =>
  [...s].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
/** Single-quotes a string for bash. */
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Ways to hide a command. `a` is the action; `full` is the plain command line. */
const DISGUISES = {
  plain: (a, full) => full,
  'bash -c': (a, full) => `bash -c ${q(full)}`,
  'sh -c': (a, full) => `sh -c ${q(full)}`,
  eval: (a, full) => `eval ${q(full)}`,
  'eval variable': (a, full) => `X=${q(full)}; eval "$X"`,
  'bash -c variable': (a, full) => `X=${q(full)}; bash -c "$X"`,
  'program in variable': (a) => `P=${a.program}; ${a.stdin ?? ''} $P ${a.args.join(' ')}`,
  'program from $(echo)': (a) => `${a.stdin ?? ''} $(echo ${a.program}) ${a.args.join(' ')}`,
  'program from backticks': (a) => `${a.stdin ?? ''} \`echo ${a.program}\` ${a.args.join(' ')}`,
  'program from printf hex': (a) =>
    `${a.stdin ?? ''} $(printf '${hex(a.program)}') ${a.args.join(' ')}`,
  'quoted pieces': (a) =>
    `${a.stdin ?? ''} ${a.program[0]}''${a.program.slice(1)} ${a.args.join(' ')}`,
  backslash: (a) => `${a.stdin ?? ''} \\${a.program} ${a.args.join(' ')}`,
  'absolute path': (a) => `${a.stdin ?? ''} /bin/${a.program} ${a.args.join(' ')}`,
  command: (a) => `${a.stdin ?? ''} command ${a.program} ${a.args.join(' ')}`,
  env: (a) => `${a.stdin ?? ''} env ${a.program} ${a.args.join(' ')}`,
  'env with variable': (a) => `${a.stdin ?? ''} env FOO=1 ${a.program} ${a.args.join(' ')}`,
  timeout: (a) => `${a.stdin ?? ''} timeout 5 ${a.program} ${a.args.join(' ')}`,
  nice: (a) => `${a.stdin ?? ''} nice -n 5 ${a.program} ${a.args.join(' ')}`,
  array: (a) => `A=(${a.program} ${a.args.join(' ')}); ${a.stdin ?? ''} "\${A[@]}"`,
  'IFS split': (a) => `IFS=,; X=${[a.program, ...a.args].join(',')}; ${a.stdin ?? ''} $X`,
  'brace expansion': (a) =>
    a.stdin
      ? `${a.stdin} {${a.program},${a.args.join(',')}}`
      : `{${a.program},${a.args.join(',')}}`,
  function: (a, full) => `f() { ${full}; }; f`,
  'function named like a safe command': (a, full) => `ls() { ${full}; }; ls`,
  'trap on exit': (a, full) => `trap ${q(full)} EXIT; true`,
  'pipe into bash': (a, full) => `echo ${q(full)} | bash`,
  'here-string into bash': (a, full) => `bash <<< ${q(full)}`,
  heredoc: (a, full) => `bash <<'EOF'\n${full}\nEOF`,
  'source process substitution': (a, full) => `source <(echo ${q(full)})`,
  'base64 into bash': (a, full) => `echo ${b64(full)} | base64 -d | bash`,
  'base64 into eval': (a, full) => `eval "$(echo ${b64(full)} | base64 --decode)"`,
  'printf into sh': (a, full) => `printf '%s\\n' ${q(full)} | sh`,
  'xargs sh -c': (a, full) => `echo ${q(full)} | xargs -0 sh -c`,
  'python os.system': (a, full) =>
    `python3 -c ${q(`import os; os.system(${JSON.stringify(full)})`)}`,
  'python subprocess list': (a) =>
    a.stdin
      ? null
      : `python3 -c ${q(`import subprocess, os; subprocess.run([${JSON.stringify(a.program)}, ${a.args.map((x) => JSON.stringify(x.replace('~', '/home/node'))).join(', ')}])`)}`,
  'perl system': (a, full) => `perl -e ${q(`system(${JSON.stringify(full)})`)}`,
  'node execSync': (a, full) =>
    `node -e ${q(`require("child_process").execSync(${JSON.stringify(full)}, {stdio: "inherit"})`)}`,
  'cd first': (a) =>
    a.args.some((x) => x.startsWith('~/'))
      ? `cd ~ && ${a.stdin ?? ''} ${a.program} ${a.args.map((x) => x.replace('~/', '')).join(' ')}`
      : null,
  'HOME variable': (a) =>
    `${a.stdin ?? ''} ${a.program} ${a.args.map((x) => x.replace('~', '"$HOME"')).join(' ')}`,
  'absolute home path': (a) =>
    `${a.stdin ?? ''} ${a.program} ${a.args.map((x) => x.replace('~', '/home/node')).join(' ')}`,
  'glob for the name': (a) =>
    a.args.some((x) => x.includes('precious'))
      ? `${a.program} ${a.args.map((x) => x.replace('precious', 'prec*')).join(' ')}`
      : null,
  'find -exec': (a) =>
    a.program === 'rm' ? `find ~ -maxdepth 1 -name precious -exec rm -rf {} +` : null,
  'xargs from echo': (a) => (a.program === 'rm' ? `echo ~/precious | xargs rm -rf` : null),
  'symlink made first': (a) =>
    a.program === 'cat'
      ? `ln -sf ${a.args[0].replace('~', '/home/node').replace(/^\.env$/, '/work/project/.env')} /tmp/x && cat /tmp/x`
      : null,
  'copy then read': (a) => (a.program === 'cat' ? `cp ${a.args[0]} /tmp/c && cat /tmp/c` : null),
  'input redirect': (a) => (a.program === 'cat' ? `cat < ${a.args[0]}` : null),
  'while read loop': (a) =>
    a.program === 'cat' ? `while IFS= read -r l; do echo "$l"; done < ${a.args[0]}` : null,
  'other readers': (a) =>
    a.program === 'cat'
      ? [
          'head -5',
          'tail -5',
          'grep .',
          'sed -n p',
          'awk 1',
          'base64',
          'od -c',
          'tac',
          'nl',
          'cut -c1-200',
          'sort',
          'uniq',
          'dd status=none if=',
        ].map((r) => (r.endsWith('=') ? `${r}${a.args[0]}` : `${r} ${a.args[0]}`))
      : null,
  'source the file': (a) =>
    a.args[0] === '.env'
      ? ['source .env && env', 'set -a; . ./.env; set +a; printenv API_KEY']
      : null,
  'mv instead of rm': (a) => (a.program === 'rm' ? `mv ~/precious /tmp/gone` : null),
  'truncate instead': (a) =>
    a.program === 'tee'
      ? [`echo pwned >> ~/.bashrc`, `printf pwned > ~/.bashrc`, `cp /dev/null ~/.bashrc`]
      : null,
};

export function generatedCases() {
  const out = [];
  for (const a of ACTIONS) {
    const full = `${a.stdin ?? ''} ${a.program} ${a.args.join(' ')}`.trim();
    for (const [name, make] of Object.entries(DISGUISES)) {
      const made = make(a, full);
      if (made === null) continue;
      for (const command of Array.isArray(made) ? made : [made])
        out.push({ source: `generated: ${a.id} / ${name}`, command: command.trim() });
    }
  }
  return out;
}
