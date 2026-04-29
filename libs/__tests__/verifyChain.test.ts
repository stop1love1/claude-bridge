import { describe, it, expect } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  hasAnyVerifyCommand,
  isAlreadyRetryRun,
  isEligibleForVerifyRetry,
  renderVerifyRetryContextBlock,
  runVerifyChain,
  verifyConfigOf,
  VERIFY_RETRY_SUFFIX,
} from "../verifyChain";
import type { Run, RunVerify } from "../meta";
import type { App } from "../apps";
import { mktmp } from "./helpers/fs";

/**
 * Build a portable shell command that exits with the given code AND
 * prints something to both stdout and stderr. Cross-platform: works in
 * cmd.exe (Windows default) and sh (POSIX). We use `node -e` to dodge
 * shell-builtin differences entirely — `node` is guaranteed present
 * since the test runner itself is node.
 */
function nodeCmd(script: string): string {
  // JSON-encode the script so quotes/newlines survive the shell pass.
  return `node -e ${JSON.stringify(script)}`;
}

describe("hasAnyVerifyCommand", () => {
  it("returns false for null / empty / whitespace-only", () => {
    expect(hasAnyVerifyCommand(null)).toBe(false);
    expect(hasAnyVerifyCommand(undefined)).toBe(false);
    expect(hasAnyVerifyCommand({})).toBe(false);
    expect(hasAnyVerifyCommand({ test: "" })).toBe(false);
    expect(hasAnyVerifyCommand({ test: "   ", lint: "  " })).toBe(false);
  });

  it("returns true when at least one command is set", () => {
    expect(hasAnyVerifyCommand({ test: "bun test" })).toBe(true);
    expect(hasAnyVerifyCommand({ build: "make" })).toBe(true);
    expect(hasAnyVerifyCommand({ format: "  prettier --check  " })).toBe(true);
  });
});

describe("verifyConfigOf", () => {
  it("returns null when app is null", () => {
    expect(verifyConfigOf(null)).toBeNull();
  });

  it("returns the app's verify config", () => {
    const app = { verify: { test: "bun test" } } as App;
    expect(verifyConfigOf(app)).toEqual({ test: "bun test" });
  });
});

describe("isAlreadyRetryRun", () => {
  it("flags any role ending in -retry or -vretry", () => {
    expect(isAlreadyRetryRun("coder-retry")).toBe(true);
    expect(isAlreadyRetryRun("coder-vretry")).toBe(true);
    expect(isAlreadyRetryRun("style-critic-vretry")).toBe(true);
    expect(isAlreadyRetryRun("coder")).toBe(false);
    expect(isAlreadyRetryRun("reviewer")).toBe(false);
  });

  it("VERIFY_RETRY_SUFFIX is the literal -vretry", () => {
    expect(VERIFY_RETRY_SUFFIX).toBe("-vretry");
  });
});

describe("isEligibleForVerifyRetry", () => {
  const baseRun: Run = {
    sessionId: "11111111-1111-1111-1111-111111111111",
    role: "coder",
    repo: "app-web",
    status: "done",
    startedAt: null,
    endedAt: null,
    parentSessionId: "00000000-0000-0000-0000-000000000000",
  };

  it("rejects runs with no parent session", () => {
    expect(
      isEligibleForVerifyRetry({
        finishedRun: { ...baseRun, parentSessionId: null },
        meta: { runs: [] },
      }),
    ).toBe(false);
  });

  it("rejects runs that are already retries (-retry or -vretry)", () => {
    expect(
      isEligibleForVerifyRetry({
        finishedRun: { ...baseRun, role: "coder-retry" },
        meta: { runs: [] },
      }),
    ).toBe(false);
    expect(
      isEligibleForVerifyRetry({
        finishedRun: { ...baseRun, role: "coder-vretry" },
        meta: { runs: [] },
      }),
    ).toBe(false);
  });

  it("rejects when a -vretry sibling already exists for the same parent+role", () => {
    const sibling: Run = {
      ...baseRun,
      sessionId: "22222222-2222-2222-2222-222222222222",
      role: "coder-vretry",
    };
    expect(
      isEligibleForVerifyRetry({
        finishedRun: baseRun,
        meta: { runs: [baseRun, sibling] },
      }),
    ).toBe(false);
  });

  it("allows even when a crash-retry sibling exists (independent budgets)", () => {
    const crashRetry: Run = {
      ...baseRun,
      sessionId: "33333333-3333-3333-3333-333333333333",
      role: "coder-retry",
    };
    expect(
      isEligibleForVerifyRetry({
        finishedRun: baseRun,
        meta: { runs: [baseRun, crashRetry] },
      }),
    ).toBe(true);
  });

  it("allows the first verify-retry attempt", () => {
    expect(
      isEligibleForVerifyRetry({
        finishedRun: baseRun,
        meta: { runs: [baseRun] },
      }),
    ).toBe(true);
  });
});

describe("renderVerifyRetryContextBlock", () => {
  it("includes the failed step name, exit code, command, and raw output", () => {
    const verify: RunVerify = {
      steps: [
        {
          name: "format",
          cmd: "prettier --check .",
          ok: true,
          exitCode: 0,
          durationMs: 120,
          output: "",
        },
        {
          name: "lint",
          cmd: "eslint src/",
          ok: false,
          exitCode: 1,
          durationMs: 480,
          output: "src/foo.ts:5:1  error  Parsing error",
        },
      ],
      passed: false,
      startedAt: "2026-04-26T12:00:00.000Z",
      endedAt: "2026-04-26T12:00:01.000Z",
    };
    const out = renderVerifyRetryContextBlock(verify);
    expect(out).toContain("## Auto-retry context — what failed last time");
    expect(out).toContain("Failed step: `lint` (exit 1)");
    expect(out).toContain("Command: `eslint src/`");
    expect(out).toContain("src/foo.ts:5:1  error  Parsing error");
    expect(out).toContain("- `format` ✓");
  });

  it("handles a chain with no recorded steps (defensive)", () => {
    const verify: RunVerify = {
      steps: [],
      passed: false,
      startedAt: "2026-04-26T12:00:00.000Z",
      endedAt: "2026-04-26T12:00:00.000Z",
    };
    const out = renderVerifyRetryContextBlock(verify);
    expect(out).toContain("(none recorded — chain produced no entries)");
  });

  it("substitutes a placeholder when the failed step has no output", () => {
    const verify: RunVerify = {
      steps: [
        {
          name: "build",
          cmd: "make",
          ok: false,
          exitCode: 2,
          durationMs: 50,
          output: "",
        },
      ],
      passed: false,
      startedAt: "2026-04-26T12:00:00.000Z",
      endedAt: "2026-04-26T12:00:00.000Z",
    };
    const out = renderVerifyRetryContextBlock(verify);
    expect(out).toContain("(no output captured)");
  });

  it("formats null exit code as a timeout-friendly hint", () => {
    const verify: RunVerify = {
      steps: [
        {
          name: "test",
          cmd: "bun test",
          ok: false,
          exitCode: null,
          durationMs: 300_000,
          output: "(bridge: aborted after 300000ms timeout)",
        },
      ],
      passed: false,
      startedAt: "2026-04-26T12:00:00.000Z",
      endedAt: "2026-04-26T12:05:00.000Z",
    };
    const out = renderVerifyRetryContextBlock(verify);
    expect(out).toContain("non-zero (no code captured");
    expect(out).toContain("aborted after 300000ms");
  });
});

describe("runVerifyChain", () => {
  it("runs configured steps in canonical order and stops on first failure", async () => {
    const cwd = mktmp("order");
    try {
      const result = await runVerifyChain({
        cwd,
        verify: {
          test: nodeCmd("process.exit(0)"),
          // Lint runs BEFORE test in canonical order — it'll fail and
          // the chain must stop here without running test.
          lint: nodeCmd("console.log('lint failed'); process.exit(7)"),
          typecheck: nodeCmd("process.exit(0)"),
        },
      });
      expect(result.passed).toBe(false);
      // format wasn't configured; lint ran and failed; typecheck/test
      // never ran because the chain stopped at lint.
      expect(result.steps.map((s) => s.name)).toEqual(["lint"]);
      expect(result.steps[0].ok).toBe(false);
      expect(result.steps[0].exitCode).toBe(7);
      expect(result.steps[0].output).toContain("lint failed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  it("returns passed=true when every configured step succeeds", async () => {
    const cwd = mktmp("pass");
    try {
      const result = await runVerifyChain({
        cwd,
        verify: {
          format: nodeCmd("process.stdout.write('ok')"),
          test: nodeCmd("process.exit(0)"),
        },
      });
      expect(result.passed).toBe(true);
      expect(result.steps.map((s) => s.name)).toEqual(["format", "test"]);
      expect(result.steps.every((s) => s.ok)).toBe(true);
      expect(result.steps[0].output).toBe("ok");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  it("treats no configured commands as passed (vacuously true), with empty steps", async () => {
    const cwd = mktmp("empty");
    try {
      // Callers that need "did we actually verify anything?" should
      // branch on `steps.length`; `passed` reflects "no failure", not
      // "we ran something". The commit gate in coordinator.ts is
      // protected upstream by `hasAnyVerifyCommand`.
      const result = await runVerifyChain({ cwd, verify: {} });
      expect(result.passed).toBe(true);
      expect(result.steps).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("caps captured output at outputCapBytes and appends a marker", async () => {
    const cwd = mktmp("cap");
    try {
      // Print 1 KB of 'x' but cap at 100 bytes — output should be
      // truncated and carry the truncation marker.
      const script = "process.stdout.write('x'.repeat(1024))";
      const result = await runVerifyChain({
        cwd,
        verify: { test: nodeCmd(script) },
        outputCapBytes: 100,
      });
      expect(result.passed).toBe(true);
      const step = result.steps[0];
      expect(step.output).toContain("…(bridge: output truncated at 100 bytes)");
      // Strip the marker before measuring; what's left should be ≤100 bytes.
      const before = step.output.split("\n\n…(bridge:")[0];
      expect(Buffer.byteLength(before, "utf8")).toBeLessThanOrEqual(100);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  it("records non-zero exit code with stderr captured", async () => {
    const cwd = mktmp("stderr");
    try {
      const result = await runVerifyChain({
        cwd,
        verify: {
          typecheck: nodeCmd(
            "process.stderr.write('TS2304: cannot find name'); process.exit(2)",
          ),
        },
      });
      expect(result.passed).toBe(false);
      expect(result.steps[0].exitCode).toBe(2);
      expect(result.steps[0].output).toContain("TS2304");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  // execStep now uses treeKill (libs/processKill.ts) which shells out
  // to `taskkill /T /F` on Windows — so the timeout abort works on
  // every platform.
  it(
    "aborts a long-running step at the timeout and surfaces a marker",
    async () => {
      const cwd = mktmp("timeout");
      try {
        const result = await runVerifyChain({
          cwd,
          verify: {
            test: nodeCmd(
              "setInterval(() => {}, 1000); console.log('hung')",
            ),
          },
          timeoutMs: 300,
        });
        expect(result.passed).toBe(false);
        expect(result.steps[0].output).toContain("aborted after 300ms");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it(
    "reaps grandchildren on timeout (no heartbeat after kill)",
    async () => {
      // The verify command is a node script that writes a millisecond
      // heartbeat to <cwd>/beat.txt every 50ms forever. After the
      // timeout fires, treeKill must reap the entire subtree —
      // otherwise the grandchild keeps writing past the abort.
      const cwd = mktmp("treekill");
      const beatFile = join(cwd, "beat.txt");
      try {
        const script = [
          "const fs = require('node:fs');",
          `setInterval(() => fs.writeFileSync(${JSON.stringify(beatFile)}, String(Date.now())), 50);`,
        ].join("");
        const result = await runVerifyChain({
          cwd,
          verify: { test: nodeCmd(script) },
          timeoutMs: 400,
        });
        expect(result.passed).toBe(false);
        expect(result.steps[0].output).toContain("aborted after 400ms");

        // Wait past the SIGKILL backstop (2s) + a comfort margin so any
        // surviving grandchild has plenty of time to write again. Then
        // sample the heartbeat file and confirm it stays frozen.
        await new Promise((r) => setTimeout(r, 3000));
        const { readFileSync } = await import("node:fs");
        let snapshot: string;
        try {
          snapshot = readFileSync(beatFile, "utf8");
        } catch {
          // File may never have been created if the kill was very fast.
          snapshot = "";
        }
        await new Promise((r) => setTimeout(r, 600));
        let after: string;
        try {
          after = readFileSync(beatFile, "utf8");
        } catch {
          after = "";
        }
        expect(after).toBe(snapshot);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

