import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { serve } from '../approval/server.js';
import {
  createLinkKey,
  DEFAULT_PORT,
  ensureUiServer,
  linkUrl,
  readUiState,
} from '../approval/ui-state.js';
import { loadPolicy } from '../policy/load.js';
import { belaydHome, findWorkspace } from '../util/paths.js';

export interface UiOptions {
  serve?: boolean;
  port?: string;
  open?: boolean;
}

export async function ui(opts: UiOptions): Promise<number> {
  const home = belaydHome();
  const port = opts.port ? Number(opts.port) : await configuredPort();

  if (opts.serve) {
    await serve({ belaydHome: home, port });
    return new Promise<number>(() => {}); // runs until idle exit or a signal
  }

  let state = readUiState(home);
  if (!state) {
    ensureUiServer({ belaydHome: home, binPath: binPath(), port, env: process.env });
    for (let i = 0; i < 40 && !state; i++) {
      await new Promise((r) => setTimeout(r, 100));
      state = readUiState(home);
    }
  }
  if (!state) {
    console.error('Could not start the approval page. Try: belayd ui --serve');
    return 1;
  }

  const url = linkUrl(state, createLinkKey(home));
  console.log(`${pc.green('✔')} Approval page: ${pc.cyan(url)}`);
  console.log(
    pc.dim(
      '  The link works once, for two minutes. Keep the page open; requests appear there while agents wait.',
    ),
  );
  if (opts.open !== false) openBrowser(url);
  return 0;
}

async function configuredPort(): Promise<number> {
  try {
    const policy = await loadPolicy({
      workspace: findWorkspace(process.cwd()),
      belaydHome: belaydHome(),
    });
    return policy.approval.port;
  } catch {
    return DEFAULT_PORT;
  }
}

function binPath(): string {
  const script = process.argv[1] ?? '';
  try {
    return fs.realpathSync(script);
  } catch {
    return path.resolve(script);
  }
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // printing the URL is enough
  }
}
