import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each test file runs in its own process so process-level state
    // (env vars, signal handlers) cannot leak between suites.
    pool: "forks",
    restoreMocks: true,
  },
});
