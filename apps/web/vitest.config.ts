import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // @d3cloud/ui imports its stylesheet: let Vite load the package, so a test can render its components.
    server: { deps: { inline: ['@d3cloud/ui'] } },
  },
});
