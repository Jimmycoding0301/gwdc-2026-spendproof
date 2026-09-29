import { defineConfig } from 'vitest/config';

// Tests use explicit synthetic credentials and must never load a developer's .env.
export default defineConfig({ envDir: false, test: { include: ['tests/**/*.test.ts'] } });
