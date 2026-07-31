import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __BUILD_SHA__: JSON.stringify('test'),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/crypto/**', 'src/net/**'],
    },
  },
});
