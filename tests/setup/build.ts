import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** End-to-end tests run the built CLI, so build it once before the suite. */
export default function setup(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  execFileSync(process.execPath, [path.join(root, 'node_modules/tsup/dist/cli-default.js')], {
    cwd: root,
    stdio: 'pipe',
  });
}
