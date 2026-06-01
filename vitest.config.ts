import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Keep unit tests off disk by default. db.persist.test.ts overrides this
    // with a real temp file to exercise durable, cross-restart persistence.
    env: {
      PATTER_DB_PATH: ":memory:",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/**/*.test.ts"],
    },
  },
});
