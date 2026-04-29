import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { discoverProjectSlashCommands } from "../claudeSlashDiscovery";

describe("discoverProjectSlashCommands", () => {
  it("finds commands/*.md and skills/**/SKILL.md", async () => {
    const dir = await mkdtemp(join(tmpdir(), "slash-test-"));
    try {
      await mkdir(join(dir, ".claude", "commands"), { recursive: true });
      await writeFile(join(dir, ".claude", "commands", "deploy.md"), "---\n---\nShip to prod");
      await mkdir(join(dir, ".claude", "skills", "my-skill"), { recursive: true });
      await writeFile(
        join(dir, ".claude", "skills", "my-skill", "SKILL.md"),
        `---
name: my-skill
description: Test skill
---
Body`,
      );
      const found = await discoverProjectSlashCommands(dir);
      const slugs = new Set(found.map((f) => f.slug));
      expect(slugs.has("deploy")).toBe(true);
      expect(slugs.has("my-skill")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
