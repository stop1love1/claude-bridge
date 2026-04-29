import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Vitest config for the bridge repo.
 *
 * Adds:
 *   - Path alias parity with `tsconfig.json` so `import "@/libs/foo"`
 *     works inside tests just like it does in the runtime code. Without
 *     this aliases that the Next.js runtime resolves silently fail
 *     under vitest with "Cannot find module".
 *   - Coverage gate. Reporters are kept lean (`text`, `html`) so
 *     `bun run test:coverage` is fast in CI and writes a browseable
 *     HTML report under `coverage/`. The thresholds are intentionally
 *     low for now — they're a *floor* the suite must clear, not a
 *     target. Bump them as coverage grows so we don't silently
 *     regress.
 *   - Test discovery limited to `libs/__tests__/` so an HTML page
 *     under `app/` is never accidentally picked up as a test file.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
  test: {
    include: ["libs/__tests__/**/*.test.ts"],
    // Helpers in libs/__tests__/helpers/ are imported by tests but are
    // not tests themselves. The naming alone (no `.test.ts`) excludes
    // them from `include`, so no extra config needed.
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["libs/**/*.ts"],
      exclude: [
        "libs/__tests__/**",
        "libs/client/**", // browser-only — covered indirectly by component tests
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
