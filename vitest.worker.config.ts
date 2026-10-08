import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Integration tests that run inside the real Workers runtime (workerd) with
// real Durable Objects, SQLite storage and WebSockets — configured from
// wrangler.jsonc, just like production.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    include: ['test/worker/**/*.test.ts'],
  },
});
