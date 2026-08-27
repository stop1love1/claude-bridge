import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const readFileSyncCalls = vi.hoisted(() => [] as unknown[][]);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((...args: unknown[]) => {
      readFileSyncCalls.push(args);
      return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.readFileSync,
  };
});

import {
  sumUsageFromJsonl,
  __resetUsageCacheForTests,
} from "../sessionUsage";

describe("sumUsageFromJsonl cache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "usage-cache-"));
    __resetUsageCacheForTests();
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { }
  });

  function writeUsageFile(name: string, totals: { input: number; output: number; turns: number }): string {
    const path = join(tmpDir, name);
    const lines: string[] = [];
    for (let i = 0; i < totals.turns; i++) {
      lines.push(JSON.stringify({
        type: "assistant",
        message: {
          usage: {
            input_tokens: totals.input / totals.turns,
            output_tokens: totals.output / totals.turns,
          },
        },
      }));
    }
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  }

  it("returns identical totals on a cache hit (same mtime + size)", () => {
    const file = writeUsageFile("a.jsonl", { input: 100, output: 50, turns: 2 });
    const first = sumUsageFromJsonl(file);
    expect(first).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      turns: 2,
    });
    const stBefore = statSync(file);
    const newRaw = JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 9999, output_tokens: 9999 } },
    }) + "\n";
    let padded = newRaw;
    if (padded.length < stBefore.size) {
      padded = padded + " ".repeat(stBefore.size - padded.length);
    } else if (padded.length > stBefore.size) {
      padded = padded.slice(0, stBefore.size);
    }
    expect(Buffer.byteLength(padded, "utf8")).toBe(stBefore.size);
    writeFileSync(file, padded);
    utimesSync(file, stBefore.atime, stBefore.mtime);

    const second = sumUsageFromJsonl(file);
    expect(second).toEqual(first);
  });

  it("misses on mtime change", () => {
    const file = writeUsageFile("b.jsonl", { input: 10, output: 5, turns: 1 });
    const first = sumUsageFromJsonl(file);
    expect(first.inputTokens).toBe(10);

    const st = statSync(file);
    const newMtime = new Date(st.mtimeMs + 5000);
    utimesSync(file, st.atime, newMtime);
    const second = sumUsageFromJsonl(file);
    writeFileSync(file, JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 999, output_tokens: 999 } },
    }) + "\n");
    const third = sumUsageFromJsonl(file);
    expect(third.inputTokens).toBe(999);
    expect(second.inputTokens).toBe(10);
  });

  it("misses on size change", () => {
    const file = writeUsageFile("c.jsonl", { input: 1, output: 1, turns: 1 });
    sumUsageFromJsonl(file);
    writeFileSync(file, [
      JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: 1, output_tokens: 1 } },
      }),
      JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: 7, output_tokens: 7 } },
      }),
    ].join("\n") + "\n");
    const out = sumUsageFromJsonl(file);
    expect(out.inputTokens).toBe(8);
    expect(out.turns).toBe(2);
  });

  it("does not cache missing-file results", () => {
    const ghost = join(tmpDir, "ghost.jsonl");
    const a = sumUsageFromJsonl(ghost);
    expect(a.turns).toBe(0);
    writeFileSync(ghost, JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 42, output_tokens: 17 } },
    }) + "\n");
    const b = sumUsageFromJsonl(ghost);
    expect(b.inputTokens).toBe(42);
  });

  function multiChunkUsagePayload(lineCount: number): { content: string; sizeBytes: number } {
    const lines: string[] = [];
    for (let i = 0; i < lineCount; i++) {
      lines.push(JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: 1, output_tokens: 1 } },
        padding: "x".repeat(300),
      }));
    }
    const content = lines.join("\n") + "\n";
    return { content, sizeBytes: Buffer.byteLength(content, "utf8") };
  }

  it("streams a large file instead of materialising it with readFileSync", () => {
    const { content, sizeBytes } = multiChunkUsagePayload(900);
    const file = join(tmpDir, "big.jsonl");
    writeFileSync(file, content);
    expect(sizeBytes).toBeGreaterThan(256 * 1024);

    readFileSyncCalls.length = 0;
    const out = sumUsageFromJsonl(file);
    expect(out.turns).toBe(900);
    expect(out.inputTokens).toBe(900);
    expect(out.outputTokens).toBe(900);
    expect(readFileSyncCalls.some((args) => args[0] === file)).toBe(false);
  });

  it("sums the final line even when the file has no trailing newline", () => {
    const file = join(tmpDir, "no-trailing-nl.jsonl");
    const lines = [
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 3, output_tokens: 4 } } }),
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 5, output_tokens: 6 } } }),
    ];
    writeFileSync(file, lines.join("\n"));
    const out = sumUsageFromJsonl(file);
    expect(out.turns).toBe(2);
    expect(out.inputTokens).toBe(8);
    expect(out.outputTokens).toBe(10);
  });

  it("evicts oldest entries when the cap is exceeded", () => {
    __resetUsageCacheForTests();
    const f0 = writeUsageFile("evict.jsonl", { input: 1, output: 1, turns: 1 });
    const v0 = sumUsageFromJsonl(f0);
    expect(v0.inputTokens).toBe(1);

    for (let i = 0; i < 300; i++) {
      const fi = writeUsageFile(`fill-${i}.jsonl`, { input: i, output: 0, turns: 1 });
      sumUsageFromJsonl(fi);
    }

    writeFileSync(f0, JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 555, output_tokens: 555 } },
    }) + "\n");
    const v0b = sumUsageFromJsonl(f0);
    expect(v0b.inputTokens).toBe(555);
  });
});
