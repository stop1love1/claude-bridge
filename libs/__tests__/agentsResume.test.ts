import { describe, it, expect } from "vitest";
import { buildResumePrompt } from "../resumePrompt";

describe("buildResumePrompt", () => {
  const baseOpts = {
    taskId: "t_20260429_001",
    role: "coder",
    repo: "app-api",
    parentSessionId: "11111111-1111-1111-1111-111111111111" as string | null,
    coordinatorBody: "Address the reviewer's nit at lib/foo.ts:42 — rename `bar` to `baz`.",
  };

  it("includes the task header so the child knows it is a follow-up", () => {
    const out = buildResumePrompt(baseOpts);
    expect(out).toContain(`task \`${baseOpts.taskId}\``);
    expect(out).toContain(`role \`${baseOpts.role}\``);
    expect(out).toContain(`@ \`${baseOpts.repo}\``);
    expect(out).toMatch(/Follow-up turn/i);
  });

  it("inlines the operator brief verbatim", () => {
    const out = buildResumePrompt(baseOpts);
    expect(out).toContain(baseOpts.coordinatorBody);
  });

  it("explicitly forbids re-POSTing status:done", () => {
    const out = buildResumePrompt(baseOpts);
    // Negative phrasing — same contract as the spawn path's
    // childPrompt.ts. Resume must not race wireRunLifecycle either.
    expect(out).toContain('Do not re-POST `status:"done"`');
    expect(out).toMatch(/lifecycle hook flips your run/i);
  });

  it("tells the child NOT to re-emit task body / repo profile / etc", () => {
    const out = buildResumePrompt(baseOpts);
    // The whole point of resume is saving the preamble — the child has
    // it in their transcript already.
    expect(out).toMatch(/already in this session's transcript/i);
    expect(out).toMatch(/do NOT re-read or re-emit/i);
  });

  it("references the canonical report path under sessions/<id>/reports/", () => {
    const out = buildResumePrompt(baseOpts);
    expect(out).toContain(
      `sessions/${baseOpts.taskId}/reports/${baseOpts.role}-${baseOpts.repo}.md`,
    );
  });

  it("forbids the child from running git checkout / commit / push", () => {
    const out = buildResumePrompt(baseOpts);
    expect(out).toMatch(/git is still bridge-managed/i);
  });

  it("substitutes a placeholder when the brief is empty/whitespace", () => {
    const out = buildResumePrompt({ ...baseOpts, coordinatorBody: "  " });
    expect(out).toContain("(coordinator did not provide a follow-up brief)");
  });

  it("handles a null parentSessionId without crashing", () => {
    const out = buildResumePrompt({ ...baseOpts, parentSessionId: null });
    expect(out).toContain("Coordinator session: (none — direct spawn)");
    expect(out).not.toContain("null");
  });

  it("renders the parent session id when provided", () => {
    const out = buildResumePrompt(baseOpts);
    expect(out).toContain(baseOpts.parentSessionId as string);
  });

  it("is materially shorter than the full child prompt scaffolding", () => {
    // Sanity check on the cost-savings premise. The resume prompt's
    // overhead (everything except the operator brief itself) should
    // stay under ~1.5 KB so the savings vs `buildChildPrompt` (~5 KB
    // preamble + repo context + helpers + pinned files) is real.
    const out = buildResumePrompt({ ...baseOpts, coordinatorBody: "" });
    expect(out.length).toBeLessThan(1500);
  });
});
