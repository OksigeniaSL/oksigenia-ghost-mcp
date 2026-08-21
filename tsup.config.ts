import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  minify: false,
  sourcemap: false,
  // The bin is an executable stdio MCP server.
  banner: { js: '#!/usr/bin/env node' },
  // Keep deps external (resolved at install time); we only bundle our own src.
  noExternal: [],
});
