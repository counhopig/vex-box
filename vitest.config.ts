import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    isolate: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/cli/**", "src/web/**"],
      thresholds: {
        statements: 68,
        branches: 76,
        functions: 76,
        lines: 68,
      },
    },
  },
});
