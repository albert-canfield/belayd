import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Read from package.json at runtime so there is a single source of truth. */
export const version: string = (() => {
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      return (require(candidate) as { version: string }).version;
    } catch {
      // try the next location
    }
  }
  return '0.0.0';
})();
