import { Command } from 'commander';
import pc from 'picocolors';
import { PolicyError } from '../policy/load.js';
import { version } from '../version.js';
import { check } from './check.js';

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command()
    .name('belayd')
    .description('One policy, one audit trail and one undo button for every AI coding agent.')
    .version(version, '-v, --version')
    .showHelpAfterError();

  program
    .command('check')
    .description(
      'Check a command (or a read, write or fetch) against your policy without running it',
    )
    .argument('[command...]', 'shell command to check, quoted')
    .option('--read <path>', 'check reading a file instead')
    .option('--write <path>', 'check writing a file instead')
    .option('--fetch <url>', 'check fetching a URL instead')
    .option('--cwd <dir>', 'pretend the command runs in this directory')
    .option('--policy <file>', 'use this policy file')
    .option(
      '--preset <name>',
      'use a preset and ignore policy files (balanced, strict, yolo-with-undo)',
    )
    .option('--explain', 'show every command found inside, with its verdict')
    .option('--json', 'print the decision as JSON')
    .action(async (words: string[], opts) => {
      process.exitCode = await check(words, opts);
    });

  program
    .command('init')
    .description('Set up belayd for the agents on this machine')
    .option('--preset <name>', 'policy preset for the new belayd.yaml', 'balanced')
    .option('--global', 'install into your user-level agent settings instead of this project')
    .option(
      '--claude-config-dir <dir>',
      'Claude Code config directory (default: $CLAUDE_CONFIG_DIR or ~/.claude)',
    )
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (opts) => {
      const { init } = await import('./init.js');
      process.exitCode = await init(opts);
    });

  program
    .command('uninstall')
    .description('Remove every hook belayd installed')
    .option('--global', 'remove from your user-level agent settings')
    .option('--claude-config-dir <dir>', 'Claude Code config directory')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (opts) => {
      const { uninstall } = await import('./init.js');
      process.exitCode = await uninstall(opts);
    });

  program
    .command('doctor')
    .description('Check that belayd is installed and working')
    .action(async () => {
      const { doctor } = await import('./doctor.js');
      process.exitCode = await doctor();
    });

  program
    .command('presets')
    .description('List the built-in policy presets')
    .action(async () => {
      const { listPresets, presetsDir } = await import('../policy/load.js');
      for (const name of listPresets()) console.log(name);
      console.log(pc.dim(`\nRead them in ${presetsDir()}`));
    });

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof PolicyError) {
      console.error(pc.red('Your belayd policy has a problem:'));
      console.error(err.message);
      process.exitCode = 78;
      return;
    }
    throw err;
  }
}
