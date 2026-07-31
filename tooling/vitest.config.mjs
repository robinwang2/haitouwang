import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    include: [
      'tests/**/*.unit.test.mjs',
      '../apps/**/*.unit.test.{ts,tsx}',
      '../services/**/*.unit.test.ts',
    ],
    passWithNoTests: false,
    reporters: ['default'],
  },
});
