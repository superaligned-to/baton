import { defineConfig } from "vitest/config";

const COVERAGE_FLOOR = 100;

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        lines: COVERAGE_FLOOR,
        functions: COVERAGE_FLOOR,
        branches: COVERAGE_FLOOR,
        statements: COVERAGE_FLOOR,
      },
    },
  },
});
