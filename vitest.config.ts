/**
 * Vitest for the app itself.
 *
 * The compiler has its own harness in `packages/layout-core`. This one covers the
 * editor's pure logic — camera focus resolution, the publish payload, the refuse
 * gate — which is where a silent regression would otherwise only show up as a
 * confusing behaviour in the UI.
 *
 * No DOM: everything tested here is a function of the document.
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the `paths` entry in tsconfig.json, so tests import the same
      // specifier the app does.
      'layout-core': fileURLToPath(
        new URL('./packages/layout-core/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
