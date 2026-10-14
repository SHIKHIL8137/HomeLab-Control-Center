import { defineConfig } from 'vitest/config';

// Several suites hash passwords with scrypt or run docker compose / bash, which is slow on a loaded machine.
export default defineConfig({ test: { testTimeout: 30_000 } });
