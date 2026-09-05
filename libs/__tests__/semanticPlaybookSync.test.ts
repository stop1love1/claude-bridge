import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { INSUFFICIENT_EVIDENCE } from "../semanticVerifier";
import { playbookPath } from "../playbooks";

/**
 * The judge takes its output schema from the playbook — `childPrompt` tells it
 * "Your playbook gives the JSON schema for the verdict's contents" — while the
 * bridge parses that output in `semanticVerifier`. When the two disagree the
 * judge cannot emit a value the bridge is waiting for: the abstain verdict was
 * live in code for a whole panel while the playbook still declared exactly
 * `pass | drift | broken`, so all three judges voted `drift` on a change none of
 * them could find. These assertions fail the next time the pair drifts apart.
 */
describe("semantic-verifier playbook is in sync with the code", () => {
  const playbook = readFileSync(playbookPath("semantic-verifier"), "utf8");

  it("declares the abstain verdict in the JSON schema block", () => {
    const schema = playbook.slice(
      playbook.indexOf('"verdict":'),
      playbook.indexOf('"reason":'),
    );
    expect(schema).not.toBe("");
    expect(schema).toContain(`"${INSUFFICIENT_EVIDENCE}"`);
  });

  it("documents the abstain verdict on the verdict scale, with when to use it", () => {
    const scale = playbook.slice(playbook.indexOf("## Verdict scale"));
    const line = scale
      .split(/\r?\n/)
      .find((l) => l.startsWith(`- \`${INSUFFICIENT_EVIDENCE}\``));
    expect(line, "verdict scale must list the abstain value").toBeDefined();
    // The judge needs the trigger, not just the name: no diff OR no report.
    expect(line).toMatch(/report/i);
  });

  it("still declares the three verdicts the bridge actually gates on", () => {
    for (const verdict of ["pass", "drift", "broken"]) {
      expect(playbook).toContain(`- \`${verdict}\``);
    }
  });
});
