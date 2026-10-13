import { defineConfig } from 'tsup';

export default defineConfig({
  // bin.js is the only entry: it routes `belayd hook` to the hot path and
  // everything else to the CLI, both loaded lazily as separate chunks.
  entry: { bin: 'src/bin.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  splitting: true,
  clean: true,
  sourcemap: false,
  dts: false,
  // Bundle every dependency. One file per chunk loads much faster than resolving
  // node_modules on each hook call, and the package ships with no runtime deps.
  noExternal: [/.*/],
  // node:sqlite only exists with the prefix, so keep node: on built-in imports.
  removeNodeProtocol: false,
  // Some bundled CommonJS code calls require() for Node built-ins.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __belaydCreateRequire } from 'node:module';",
      'const require = __belaydCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
