import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest } from "next/server";

const TMP_STATE = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-rolesapi-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, BRIDGE_STATE_DIR: TMP_STATE };
});

import { _resetForTests, listCustomRoles } from "../roleStore";
import { DELETE, GET, PATCH, POST } from "@/app/api/bridge/roles/route";
import {
  GET as EXPORT,
  POST as IMPORT,
} from "@/app/api/bridge/roles/bundle/route";

const ROLES_FILE = join(TMP_STATE, "roles.json");
const READ_ONLY_DENY = ["Edit", "MultiEdit", "NotebookEdit", "Task"];

/** The handlers only ever touch `req.json()` / `req.nextUrl`. */
function reqWith(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function reqWithBadJson(): NextRequest {
  return {
    json: async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    },
  } as unknown as NextRequest;
}

function reqWithQuery(qs: string): NextRequest {
  return {
    nextUrl: new URL(`http://localhost:7777/api/bridge/roles${qs}`),
  } as unknown as NextRequest;
}

function clearStore(): void {
  if (existsSync(ROLES_FILE)) rmSync(ROLES_FILE, { force: true });
  _resetForTests();
}

beforeEach(clearStore);
afterEach(clearStore);

describe("POST /api/bridge/roles — body validation", () => {
  it("rejects a JSON body that is not an object with 400, never 500", async () => {
    for (const body of [null, [], ["x"], 5, 0, "coder", "", true]) {
      const res = await POST(reqWith(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: "body must be a JSON object" });
    }
  });

  it("rejects unparseable JSON with 400", async () => {
    const res = await POST(reqWithBadJson());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });

  it("rejects a missing name, a bad name and a non-boolean mutating", async () => {
    for (const body of [
      {},
      { name: "", mutating: true },
      { name: "with space", mutating: true },
      { name: "ok-role" },
      { name: "ok-role", mutating: "yes" },
      { name: "ok-role", mutating: true, disallowedTools: "Edit" },
      { name: "ok-role", mutating: true, disallowedTools: ["not a tool"] },
      { name: "ok-role", mutating: true, playbook: 12 },
    ]) {
      const res = await POST(reqWith(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(listCustomRoles()).toEqual([]);
  });

  it("409s on a name a built-in owns, and on a duplicate", async () => {
    for (const name of ["planner", "coder-api"]) {
      const res = await POST(reqWith({ name, mutating: true }));
      expect(res.status, name).toBe(400);
    }
    expect((await POST(reqWith({ name: "perf-tuner", mutating: true }))).status).toBe(200);
    const dup = await POST(reqWith({ name: "perf-tuner", mutating: true }));
    expect(dup.status).toBe(409);
  });
});

describe("the role CRUD round-trip an operator drives from Settings", () => {
  it("creates, lists, patches and deletes without touching a TS file", async () => {
    const created = await POST(
      reqWith({
        name: "security-auditor",
        mutating: false,
        description: "Audits a diff for auth bugs.",
        playbook: "# Rubric\n- auth on every route",
      }),
    );
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      role: { name: string };
      roles: Array<{ name: string; disallowedTools: string[] }>;
      custom: Array<{ name: string }>;
    };
    expect(createdBody.role.name).toBe("security-auditor");
    expect(createdBody.custom.map((r) => r.name)).toEqual(["security-auditor"]);
    const spec = createdBody.roles.find((r) => r.name === "security-auditor");
    expect(spec?.disallowedTools).toEqual(READ_ONLY_DENY);

    const listed = (await GET().json()) as {
      roles: Array<{ name: string }>;
      custom: Array<{ name: string; playbook: string | null }>;
    };
    expect(listed.roles.map((r) => r.name)).toContain("security-auditor");
    expect(listed.custom[0].playbook).toContain("auth on every route");

    const patched = await PATCH(
      reqWith({ name: "security-auditor", description: "Audits auth and injection." }),
    );
    expect(patched.status).toBe(200);
    expect(listCustomRoles()[0].description).toBe("Audits auth and injection.");

    expect((await PATCH(reqWith({ mutating: true }))).status).toBe(400);
    expect((await PATCH(reqWith({ name: "nope-role", mutating: true }))).status).toBe(404);

    const deleted = DELETE(reqWithQuery("?name=security-auditor"));
    expect(deleted.status).toBe(200);
    expect(listCustomRoles()).toEqual([]);
    expect(DELETE(reqWithQuery("?name=security-auditor")).status).toBe(404);
    expect(DELETE(reqWithQuery("")).status).toBe(400);
    // Built-ins live in the code table, not the overlay: nothing to delete.
    expect(DELETE(reqWithQuery("?name=planner")).status).toBe(404);
  });

  it("a role created through the API cannot loosen its deny-list", async () => {
    const res = await POST(
      reqWith({ name: "sneaky-auditor", mutating: false, disallowedTools: [] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      roles: Array<{ name: string; disallowedTools: string[]; orchestrator: boolean }>;
    };
    const spec = body.roles.find((r) => r.name === "sneaky-auditor");
    expect(spec?.disallowedTools).toEqual(READ_ONLY_DENY);
    expect(spec?.orchestrator).toBe(false);
  });

  it("ignores an orchestrator flag smuggled through the API", async () => {
    await POST(
      reqWith({ name: "fake-coordinator", mutating: true, orchestrator: true }),
    );
    const body = (await GET().json()) as {
      roles: Array<{ name: string; orchestrator: boolean }>;
    };
    expect(body.roles.find((r) => r.name === "fake-coordinator")?.orchestrator).toBe(false);
  });
});

describe("GET/POST /api/bridge/roles/bundle — packaging", () => {
  it("exports one JSON file and imports it back to the same set", async () => {
    await POST(reqWith({ name: "perf-tuner", mutating: true, description: "hot paths" }));
    await POST(
      reqWith({ name: "security-auditor", mutating: false, playbook: "# Rubric" }),
    );
    const before = listCustomRoles();

    const exported = EXPORT();
    expect(exported.headers.get("content-disposition")).toContain("bridge-roles.json");
    const bundle = (await exported.json()) as { kind: string; roles: unknown[] };
    expect(bundle.kind).toBe("bridge-roles");
    expect(bundle.roles).toHaveLength(2);

    clearStore();
    expect(listCustomRoles()).toEqual([]);

    const res = await IMPORT(reqWith({ bundle, mode: "replace" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 2, skipped: 0 });
    expect(listCustomRoles()).toEqual(before);
  });

  it("accepts the bare envelope as well as a wrapped one", async () => {
    const res = await IMPORT(
      reqWith({ version: 1, kind: "bridge-roles", roles: [{ name: "perf-tuner", mutating: true }] }),
    );
    expect(res.status).toBe(200);
    expect(listCustomRoles().map((r) => r.name)).toEqual(["perf-tuner"]);
  });

  it("rejects a non-object body, a bad mode and a bundle without roles", async () => {
    for (const body of [null, [], 5, "x"]) {
      const res = await IMPORT(reqWith(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await IMPORT(reqWithBadJson())).status).toBe(400);
    expect((await IMPORT(reqWith({ roles: [], mode: "wipe" }))).status).toBe(400);
    expect((await IMPORT(reqWith({ nope: 1 }))).status).toBe(400);
    expect((await IMPORT(reqWith({ bundle: { roles: "no" } }))).status).toBe(400);
  });
});
