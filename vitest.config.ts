import { defineConfig } from 'vitest/config';

// Fast unit tests that run in Node: shared protocol, match rules, UI helpers.
// Worker + Durable Object integration tests use vitest.worker.config.ts.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
