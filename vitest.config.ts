import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
  test: {
    include: [
      "libs/__tests__/**/*.test.ts",
      "app/**/__tests__/**/*.test.{ts,tsx}",
    ],
    /**
     * Clear every mock's call history before each test.
     *
     * Without it, `mock.calls` accumulates across `it()` blocks in a file, so
     * an assertion like `expect(escalateCalls).toHaveLength(1)` only holds
     * while the test that escalates first happens to be declared first. That
     * is an order dependence in every mock-using file at once, which is why it
     * is fixed here rather than per file. Implementations set via
     * `mockReturnValue` are untouched (`clearMocks`, not `resetMocks`).
     */
    clearMocks: true,
    // Isolates `globalThis.__bridge*` stores and `process.cwd()` per test
    // file — see the file for why a worker-reused process needs this.
    setupFiles: ["./vitest.setup.ts"],
    /**
     * The console reporter plus a full JSON transcript on disk.
     *
     * The bridge verify gate caps a step's captured stdout at 16KB and keeps
     * the FIRST 16KB, but vitest prints its summary and the failed-test list
     * last — so every red run in this repo has lost exactly the part needed to
     * diagnose it. This file is written whole, every run, and is the thing to
     * read after a gate failure. Gitignored via `.bridge-state/`.
     */
    reporters: ["default", "json"],
    outputFile: { json: ".bridge-state/vitest-last-run.json" },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["libs/**/*.ts"],
      exclude: [
        "libs/__tests__/**",
        "libs/client/**",
        "libs/**/*.d.ts",
      ],
      thresholds: {
        lines: 50,
        functions: 50,
        statements: 50,
        branches: 40,
      },
    },
  },
});
