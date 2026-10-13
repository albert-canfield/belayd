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
  banner: { js: '#!/usr/bin/env node' },
});
