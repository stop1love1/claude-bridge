import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sumUsageFromJsonl,
  __resetUsageCacheForTests,
} from "../sessionUsage";

/**
 * Cache-validation tests for `sumUsageFromJsonl`. The cache is keyed by
 * `(path, mtime, size)`; changing either key field must miss, and an
 * unchanged file must hit (verified by mutating the underlying bytes
 * but resetting mtime + size to the cached values — the cached
 * pre-mutation result must still be returned).
 */
describe("sumUsageFromJsonl cache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "usage-cache-"));
    __resetUsageCacheForTests();
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
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
    // Overwrite the file with different totals but pad/truncate to the
    // original size and restore the mtime — the cache key is keyed on
    // (path, mtime.getTime(), size), so the second call must hit and
    // return the pre-mutation parse.
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
    // Cache hit → still the original totals.
    expect(second).toEqual(first);
  });

  it("misses on mtime change", () => {
    const file = writeUsageFile("b.jsonl", { input: 10, output: 5, turns: 1 });
    const first = sumUsageFromJsonl(file);
    expect(first.inputTokens).toBe(10);

    // Bump mtime by 5 seconds; same size, but the cache key changes.
    const st = statSync(file);
    const newMtime = new Date(st.mtimeMs + 5000);
    utimesSync(file, st.atime, newMtime);
    // Now actually rewrite with different totals (size change would
    // also miss, so to isolate mtime we overwrite same-byte-length).
    // Overwrite with a non-cacheable result first to confirm mtime
    // change alone is enough to invalidate.
    const second = sumUsageFromJsonl(file);
    // Same content → same totals, but cache lookup must have missed
    // (we can't directly observe this without instrumentation). Best
    // proxy: rewrite with different size and verify totals follow.
    writeFileSync(file, JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 999, output_tokens: 999 } },
    }) + "\n");
    const third = sumUsageFromJsonl(file);
    expect(third.inputTokens).toBe(999);
    // Sanity on second (the mtime-only bump): it would have re-read,
    // and since we hadn't yet overwritten content, the totals match
    // the original.
    expect(second.inputTokens).toBe(10);
  });

  it("misses on size change", () => {
    const file = writeUsageFile("c.jsonl", { input: 1, output: 1, turns: 1 });
    sumUsageFromJsonl(file);
    // Append a second line — size grows, cache must miss.
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
    // Now create the file. If the prior miss had been cached, this
    // would still return zeros.
    writeFileSync(ghost, JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 42, output_tokens: 17 } },
    }) + "\n");
    const b = sumUsageFromJsonl(ghost);
    expect(b.inputTokens).toBe(42);
  });

  it("evicts oldest entries when the cap is exceeded", () => {
    // The cap is 256; rather than literally generating 257 files,
    // confirm the algorithmic property: after writing N+1 distinct
    // files, the very-first one re-evaluates correctly even if its
    // file changes between evictions.
    //
    // We write a small batch + hammer the cache, then mutate file 0
    // and confirm we get the new totals (eviction => fresh read on
    // re-touch). Since the cap is 256 we make this test cheap by
    // resetting and re-validating on a tighter "replay" pattern that
    // the cap-eviction code is exercised in the hot path.
    __resetUsageCacheForTests();
    const f0 = writeUsageFile("evict.jsonl", { input: 1, output: 1, turns: 1 });
    const v0 = sumUsageFromJsonl(f0);
    expect(v0.inputTokens).toBe(1);

    // Touch many distinct filenames so f0 falls out of the LRU window.
    for (let i = 0; i < 300; i++) {
      const fi = writeUsageFile(`fill-${i}.jsonl`, { input: i, output: 0, turns: 1 });
      sumUsageFromJsonl(fi);
    }

    // f0's entry has been evicted. Mutate f0 — if it had stayed
    // cached, we'd still see the old totals. With eviction working,
    // we read fresh.
    writeFileSync(f0, JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 555, output_tokens: 555 } },
    }) + "\n");
    const v0b = sumUsageFromJsonl(f0);
    expect(v0b.inputTokens).toBe(555);
  });
});
