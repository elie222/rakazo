import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/release-desktop.yml"),
  "utf8",
);

describe("desktop release workflow", () => {
  it("cannot execute contributor pull-request code with release credentials", () => {
    expect(workflow).not.toMatch(/^\s*pull_request:/m);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(3);
  });

  it("pins every third-party action to an immutable commit", () => {
    const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference, reference).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("requires signed platform builds before a single publication job", () => {
    expect(workflow).toContain("-c.forceCodeSigning=true");
    expect(workflow).toContain("codesign --verify --deep --strict");
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain("needs: [validate, build]");
    expect(workflow).toContain("attestations: write");
    expect(workflow).toContain("actions/attest-build-provenance@");
    expect(workflow).not.toContain("--publish always");
    expect(workflow).toContain("DESKTOP_MAC_CSC_LINK");
    expect(workflow).toContain("DESKTOP_WIN_CSC_LINK");
    expect(workflow).not.toMatch(/secrets\.DESKTOP_CSC_(?:LINK|KEY_PASSWORD)/);
  });

  it("publishes only a complete stable, upgrade-only feed", () => {
    expect(workflow).toContain("^v([0-9]+)\\.([0-9]+)\\.([0-9]+)$");
    expect(workflow).toContain("must be newer than published release");
    expect(workflow).toContain("group: release-desktop-stable");
    expect(workflow).toContain("latest.yml");
    expect(workflow).toContain("latest-mac.yml");
    expect(workflow).toContain("latest-linux.yml");
    expect(workflow).toContain("--draft --generate-notes");
    expect(workflow).toContain("--draft=false --latest");
  });
});
