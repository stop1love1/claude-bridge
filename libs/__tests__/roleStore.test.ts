import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TMP_STATE = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-rolestore-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, BRIDGE_STATE_DIR: TMP_STATE };
});

import {
  _resetForTests,
  createCustomRole,
  deleteCustomRole,
  exportRoleBundle,
  findCustomRole,
  getCustomRole,
  importRoleBundle,
  listCustomRoles,
  loadCustomPlaybook,
  updateCustomRole,
} from "../roleStore";
import { listRoles, resolveRole } from "../roleRegistry";
import { isMutatingRole } from "../planGate";
import { loadPlaybook } from "../playbooks";

const ROLES_FILE = join(TMP_STATE, "roles.json");
const READ_ONLY_DENY = ["Edit", "MultiEdit", "NotebookEdit", "Task"];

/** The built-in table as it stands with no overlay file — the pass/fail baseline. */
function builtinSnapshot(): ReturnType<typeof listRoles> {
  clearStore();
  return listRoles();
}

function clearStore(): void {
  if (existsSync(ROLES_FILE)) rmSync(ROLES_FILE, { force: true });
  _resetForTests();
}

beforeEach(clearStore);
afterEach(clearStore);

describe("roleStore — absent overlay is the pre-overlay bridge", () => {
  it("listRoles() with no roles.json is exactly the built-in table", () => {
    expect(existsSync(ROLES_FILE)).toBe(false);
    expect(listCustomRoles()).toEqual([]);

    const roles = listRoles();
    const names = roles.map((r) => r.name);
    expect(names).toEqual([
      "coordinator",
      "coder",
      "fixer",
      "api-builder",
      "ui-builder",
      "writer",
      "planner",
      "reviewer",
      "researcher",
      "surveyor",
      "ui-tester",
      "semantic-verifier",
      "style-critic",
      "memory-distill",
      "devops",
    ]);
    expect(resolveRole("coder").disallowedTools).toEqual(["Task"]);
    expect(resolveRole("planner").disallowedTools).toEqual(READ_ONLY_DENY);
    expect(loadCustomPlaybook("coder")).toBeNull();
  });

  it("a corrupt roles.json degrades to no custom roles instead of throwing", () => {
    writeFileSync(ROLES_FILE, "{ not json", "utf8");
    _resetForTests();
    expect(listCustomRoles()).toEqual([]);
    expect(listRoles().map((r) => r.name)).toEqual(builtinSnapshot().map((r) => r.name));
  });

  it("drops unusable entries from a hand-edited file but keeps the good ones", () => {
    writeFileSync(
      ROLES_FILE,
      JSON.stringify({
        roles: [
          { name: "Security Auditor", mutating: false }, // spaces + caps
          { name: "planner", mutating: true }, // built-in name
          null,
          { name: "perf-tuner", mutating: true, description: "Profiles hot paths." },
        ],
      }),
      "utf8",
    );
    _resetForTests();
    expect(listCustomRoles().map((r) => r.name)).toEqual(["perf-tuner"]);
  });
});

describe("roleStore — create / update / delete", () => {
  it("creates a role that resolves on the very next dispatch, no file edit", () => {
    const res = createCustomRole({
      name: "security-auditor",
      mutating: false,
      description: "Audits a diff for auth and injection bugs.",
      playbook: "# Security auditor\n\nCheck every new route for auth.",
    });
    expect(res.ok).toBe(true);

    const spec = resolveRole("security-auditor");
    expect(spec.mutating).toBe(false);
    expect(spec.description).toBe("Audits a diff for auth and injection bugs.");
    expect(listRoles().map((r) => r.name)).toContain("security-auditor");
    // The plan gate reads the same registry, so classification cannot drift.
    expect(isMutatingRole("security-auditor")).toBe(false);
    // …and the playbook the operator typed is what a child prompt would load.
    expect(loadPlaybook("security-auditor")).toContain("Check every new route");
    expect(spec.playbook).toBe("security-auditor");
  });

  it("keeps prefix inheritance for custom roles too", () => {
    createCustomRole({ name: "perf-tuner", mutating: true, description: "" });
    expect(resolveRole("perf-tuner-api").name).toBe("perf-tuner");
    expect(resolveRole("PERF-TUNER-2").name).toBe("perf-tuner");
    // Not a dash-suffix: still an unregistered role.
    expect(resolveRole("perf-tuners").name).toBe("perf-tuners");
    expect(findCustomRole("perf-tuner-api")?.name).toBe("perf-tuner");
  });

  it("rejects names a built-in already owns, exactly or by prefix", () => {
    for (const name of ["planner", "coder", "reviewer-api", "coder-phase24", "PLANNER"]) {
      const res = createCustomRole({ name, mutating: true });
      expect(res.ok, name).toBe(false);
    }
    expect(listCustomRoles()).toEqual([]);
  });

  it("rejects malformed names and duplicates", () => {
    expect(createCustomRole({ name: "", mutating: true }).ok).toBe(false);
    expect(createCustomRole({ name: "../etc/passwd", mutating: true }).ok).toBe(false);
    expect(createCustomRole({ name: "with space", mutating: true }).ok).toBe(false);
    expect(createCustomRole({ name: "-leading", mutating: true }).ok).toBe(false);
    expect(createCustomRole({ name: "trailing-", mutating: true }).ok).toBe(false);
    expect(createCustomRole({ name: "double--dash", mutating: true }).ok).toBe(false);
    expect(createCustomRole({ name: "ok-role", mutating: "yes" as never }).ok).toBe(false);

    expect(createCustomRole({ name: "ok-role", mutating: true }).ok).toBe(true);
    const dup = createCustomRole({ name: "ok-role", mutating: true });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.status).toBe(409);
  });

  it("updates in place and 404s on an unknown role", () => {
    createCustomRole({ name: "perf-tuner", mutating: true, description: "old" });
    const up = updateCustomRole("perf-tuner", { description: "new", mutating: false });
    expect(up.ok).toBe(true);
    expect(getCustomRole("perf-tuner")?.description).toBe("new");
    expect(resolveRole("perf-tuner").mutating).toBe(false);
    expect(resolveRole("perf-tuner").disallowedTools).toEqual(READ_ONLY_DENY);

    const missing = updateCustomRole("nope-role", { description: "x" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);
  });

  it("deletes and the role disappears from the registry", () => {
    createCustomRole({ name: "perf-tuner", mutating: true });
    expect(deleteCustomRole("perf-tuner")).toBe(true);
    expect(deleteCustomRole("perf-tuner")).toBe(false);
    expect(resolveRole("perf-tuner").description).toContain("Unregistered role");
    expect(listRoles().map((r) => r.name)).toEqual(builtinSnapshot().map((r) => r.name));
  });

  it("persists through writeJsonAtomic, so a fresh process sees the same roles", () => {
    createCustomRole({ name: "perf-tuner", mutating: true, description: "hot paths" });
    const onDisk = JSON.parse(readFileSync(ROLES_FILE, "utf8")) as {
      version: number;
      roles: Array<{ name: string }>;
    };
    expect(onDisk.version).toBe(1);
    expect(onDisk.roles.map((r) => r.name)).toEqual(["perf-tuner"]);

    _resetForTests(); // simulate a cold process
    expect(listCustomRoles().map((r) => r.name)).toEqual(["perf-tuner"]);
  });
});

// ---------------------------------------------------------------------------
// The part that must never regress: a UI-defined role cannot widen privilege.
// ---------------------------------------------------------------------------

describe("custom roles can never loosen the deny-list", () => {
  it("an empty disallowedTools payload still gets the base deny-list", () => {
    createCustomRole({ name: "perf-tuner", mutating: true, disallowedTools: [] });
    createCustomRole({ name: "doc-auditor", mutating: false, disallowedTools: [] });

    expect(resolveRole("perf-tuner").disallowedTools).toEqual(["Task"]);
    expect(resolveRole("doc-auditor").disallowedTools).toEqual(READ_ONLY_DENY);
  });

  it("a read-only role that asks for write tools back still gets them denied", () => {
    // The payload's list is ADDITIVE — naming a tool cannot un-deny it, and
    // there is no other field that could.
    createCustomRole({
      name: "sneaky-auditor",
      mutating: false,
      disallowedTools: ["Edit", "MultiEdit", "NotebookEdit", "Task"],
    });
    const spec = resolveRole("sneaky-auditor");
    expect(spec.mutating).toBe(false);
    for (const t of READ_ONLY_DENY) expect(spec.disallowedTools).toContain(t);
    // Read-only means it skips the plan gate, so the write tools MUST be gone.
    expect(isMutatingRole("sneaky-auditor")).toBe(false);
  });

  it("a hand-edited roles.json cannot grant a read-only role write access", () => {
    // Straight at the file, bypassing every validator the API would run.
    writeFileSync(
      ROLES_FILE,
      JSON.stringify({
        roles: [
          {
            name: "sneaky-auditor",
            mutating: false,
            description: "claims read-only",
            disallowedTools: [],
            orchestrator: true,
            playbook: null,
          },
        ],
      }),
      "utf8",
    );
    _resetForTests();
    const spec = resolveRole("sneaky-auditor");
    for (const t of READ_ONLY_DENY) expect(spec.disallowedTools).toContain(t);
    // `orchestrator` is bridge-internal: it skips the repo reservation, so the
    // overlay is never allowed to set it.
    expect(spec.orchestrator).toBe(false);
  });

  it("every custom role's deny-list is a superset of the default spec's", () => {
    createCustomRole({ name: "a-role", mutating: true, disallowedTools: [] });
    createCustomRole({ name: "b-role", mutating: false, disallowedTools: [] });
    createCustomRole({ name: "c-role", mutating: true, disallowedTools: ["Bash"] });
    for (const spec of listRoles()) {
      expect(spec.disallowedTools, spec.name).toContain("Task");
      if (!spec.mutating) {
        for (const t of READ_ONLY_DENY) expect(spec.disallowedTools, spec.name).toContain(t);
      }
    }
    expect(resolveRole("c-role").disallowedTools).toEqual(["Task", "Bash"]);
  });

  it("a hand-edited built-in override never wins over the built-in table", () => {
    // `createCustomRole` refuses these names; the registry refuses them again.
    writeFileSync(
      ROLES_FILE,
      JSON.stringify({
        roles: [
          { name: "planner", mutating: true, disallowedTools: [] },
          { name: "reviewer-api", mutating: true, disallowedTools: [] },
        ],
      }),
      "utf8",
    );
    _resetForTests();
    expect(resolveRole("planner").mutating).toBe(false);
    expect(resolveRole("planner").disallowedTools).toEqual(READ_ONLY_DENY);
    expect(resolveRole("reviewer-api").mutating).toBe(false);
    expect(isMutatingRole("planner")).toBe(false);
  });
});

describe("role packaging — export / import round-trip", () => {
  it("exports every custom role and imports back to the identical set", () => {
    createCustomRole({
      name: "security-auditor",
      mutating: false,
      description: "Audits a diff.",
      playbook: "# Rubric\n- auth\n- injection",
    });
    createCustomRole({
      name: "perf-tuner",
      mutating: true,
      description: "Profiles hot paths.",
      disallowedTools: ["Bash"],
    });
    const before = listCustomRoles();
    const bundle = exportRoleBundle();
    expect(bundle.kind).toBe("bridge-roles");
    expect(bundle.version).toBe(1);
    expect(bundle.roles).toHaveLength(2);

    // Round-trip through the actual file format an operator would move.
    const serialized = JSON.parse(JSON.stringify(bundle)) as unknown;
    clearStore();
    expect(listCustomRoles()).toEqual([]);

    const res = importRoleBundle(serialized, "replace");
    expect(res.imported).toBe(2);
    expect(res.skipped).toBe(0);
    expect(listCustomRoles()).toEqual(before);
    expect(resolveRole("security-auditor").disallowedTools).toEqual(READ_ONLY_DENY);
  });

  it("merge upserts by name and keeps roles the bundle omits", () => {
    createCustomRole({ name: "keep-me", mutating: true, description: "kept" });
    createCustomRole({ name: "perf-tuner", mutating: true, description: "old" });

    const res = importRoleBundle(
      { roles: [{ name: "perf-tuner", mutating: false, description: "new" }] },
      "merge",
    );
    expect(res.replaced).toBe(1);
    expect(res.imported).toBe(0);
    expect(listCustomRoles().map((r) => r.name).sort()).toEqual(["keep-me", "perf-tuner"]);
    expect(getCustomRole("perf-tuner")?.description).toBe("new");
    expect(resolveRole("perf-tuner").mutating).toBe(false);
  });

  it("replace drops roles the bundle omits", () => {
    createCustomRole({ name: "keep-me", mutating: true });
    importRoleBundle({ roles: [{ name: "perf-tuner", mutating: true }] }, "replace");
    expect(listCustomRoles().map((r) => r.name)).toEqual(["perf-tuner"]);
  });

  it("skips unusable bundle entries instead of failing the whole import", () => {
    const res = importRoleBundle(
      {
        roles: [
          { name: "perf-tuner", mutating: true },
          { name: "planner", mutating: true },
          "nonsense",
        ],
      },
      "replace",
    );
    expect(res.imported).toBe(1);
    expect(res.skipped).toBe(2);
    expect(listCustomRoles().map((r) => r.name)).toEqual(["perf-tuner"]);
  });

  it("an imported role cannot smuggle a wider deny-list in", () => {
    importRoleBundle(
      {
        roles: [
          {
            name: "sneaky-auditor",
            mutating: false,
            disallowedTools: [],
            orchestrator: true,
          },
        ],
      },
      "replace",
    );
    const spec = resolveRole("sneaky-auditor");
    expect(spec.disallowedTools).toEqual(READ_ONLY_DENY);
    expect(spec.orchestrator).toBe(false);
  });
});
