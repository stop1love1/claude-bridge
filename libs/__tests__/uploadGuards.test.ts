import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  BLOCKED_EXTENSIONS,
  assertInsideUploadDir,
  extractExtension,
  hasBlockedExtension,
  isReservedDeviceName,
  sanitizeUploadName,
  validateUploadName,
} from "../uploadGuards";

describe("sanitizeUploadName", () => {
  it("replaces Windows-illegal characters with underscores", () => {
    expect(sanitizeUploadName('a:b*c?d"e<f>g|h\\i/j.txt')).toBe(
      "a_b_c_d_e_f_g_h_i_j.txt",
    );
  });

  it("strips leading and trailing dots and spaces", () => {
    expect(sanitizeUploadName(" .hidden.exe.")).toBe("hidden.exe");
    expect(sanitizeUploadName("...evil.exe...")).toBe("evil.exe");
    expect(sanitizeUploadName("   spaced.txt   ")).toBe("spaced.txt");
  });

  it("returns empty string for non-strings", () => {
    expect(sanitizeUploadName(undefined as unknown as string)).toBe("");
    expect(sanitizeUploadName(null as unknown as string)).toBe("");
    expect(sanitizeUploadName(42 as unknown as string)).toBe("");
  });

  it("returns empty string when only illegal/punctuation chars remain", () => {
    expect(sanitizeUploadName("...")).toBe("");
    expect(sanitizeUploadName("   ")).toBe("");
    expect(sanitizeUploadName(". . .")).toBe("");
  });
});

describe("extractExtension", () => {
  it("returns the lowercased last extension with the leading dot", () => {
    expect(extractExtension("foo.TXT")).toBe(".txt");
    expect(extractExtension("archive.tar.gz")).toBe(".gz");
    expect(extractExtension("Mixed.Case.PnG")).toBe(".png");
  });

  it("returns empty string when there is no extension", () => {
    expect(extractExtension("Makefile")).toBe("");
    expect(extractExtension("")).toBe("");
  });

  it("does NOT treat a leading-dot dotfile as an extension", () => {
    // `.bashrc` has no extension; treating the whole name as ext would
    // make every dotfile look like an executable to the blocklist.
    expect(extractExtension(".bashrc")).toBe("");
    expect(extractExtension(".env")).toBe("");
  });
});

describe("hasBlockedExtension", () => {
  it("blocks every extension in the static list", () => {
    for (const ext of BLOCKED_EXTENSIONS) {
      expect(hasBlockedExtension(`evil${ext}`)).toBe(true);
      expect(hasBlockedExtension(`Evil${ext.toUpperCase()}`)).toBe(true);
    }
  });

  it("allows benign extensions", () => {
    for (const safe of [
      "photo.png",
      "photo.PNG",
      "doc.pdf",
      "notes.txt",
      "code.ts",
      "code.tsx",
      "data.json",
      "diagram.svg",
    ]) {
      expect(hasBlockedExtension(safe)).toBe(false);
    }
  });

  it("does not block a name that lacks an extension entirely", () => {
    expect(hasBlockedExtension("Makefile")).toBe(false);
    expect(hasBlockedExtension("README")).toBe(false);
  });
});

describe("isReservedDeviceName", () => {
  it("flags Windows reserved names with or without an extension", () => {
    for (const r of [
      "CON",
      "con",
      "Con.txt",
      "PRN",
      "AUX.log",
      "NUL",
      "COM1",
      "com9.dat",
      "LPT1",
      "lpt9",
    ]) {
      expect(isReservedDeviceName(r)).toBe(true);
    }
  });

  it("does not flag look-alikes", () => {
    for (const ok of [
      "console.log",
      "auxiliary.txt",
      "nullable.json",
      "com10.bin",
      "com.txt",
      "lptx.dat",
    ]) {
      expect(isReservedDeviceName(ok)).toBe(false);
    }
  });
});

describe("validateUploadName", () => {
  it("accepts an ordinary filename and returns the sanitized form", () => {
    const r = validateUploadName("photo.PNG");
    expect(r).toEqual({ ok: true, sanitized: "photo.PNG" });
  });

  it("strips Windows-illegal chars before checking the extension", () => {
    // `evil*.exe` sanitizes to `evil_.exe` which still ends in `.exe`.
    const r = validateUploadName("evil*.exe");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked-extension");
  });

  it("catches the trailing-dot bypass (evil.exe.)", () => {
    // `evil.exe.` sanitizes to `evil.exe` and is then rejected as a
    // blocked extension.
    const r = validateUploadName("evil.exe.");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked-extension");
  });

  it("rejects empty or whitespace-only names", () => {
    expect(validateUploadName("").ok).toBe(false);
    expect(validateUploadName("   ").ok).toBe(false);
    expect(validateUploadName("...").ok).toBe(false);
  });

  it("rejects every blocked extension explicitly", () => {
    for (const ext of BLOCKED_EXTENSIONS) {
      const r = validateUploadName(`payload${ext}`);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("blocked-extension");
        expect(r.detail).toBe(ext);
      }
    }
  });

  it("rejects reserved device names case-insensitively", () => {
    for (const r of ["CON", "nul", "AUX.txt", "com1.dat", "LPT9"]) {
      const out = validateUploadName(r);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe("reserved-name");
    }
  });

  it("rejects a leading-dot name that becomes empty after stripping", () => {
    expect(validateUploadName(".").ok).toBe(false);
    expect(validateUploadName("..").ok).toBe(false);
  });
});

describe("assertInsideUploadDir", () => {
  const dir = resolve("/tmp/uploads/abc");

  it("accepts a direct child of the upload dir", () => {
    expect(assertInsideUploadDir(dir, resolve(dir, "photo.png"))).toBe(true);
  });

  it("accepts the upload dir itself", () => {
    expect(assertInsideUploadDir(dir, dir)).toBe(true);
  });

  it("rejects a path that escapes via `..`", () => {
    expect(
      assertInsideUploadDir(dir, resolve(dir, "..", "..", "etc", "passwd")),
    ).toBe(false);
  });

  it("rejects a sibling directory whose path shares a prefix", () => {
    // `/tmp/uploads/abc-evil/file` must not be accepted just because
    // it starts with `/tmp/uploads/abc`.
    const sibling = resolve("/tmp/uploads/abc-evil/file");
    expect(assertInsideUploadDir(dir, sibling)).toBe(false);
  });
});
