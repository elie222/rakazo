import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/release-desktop.yml"),
  "utf8",
);

const expression = (inner: string) => `\${{ ${inner} }}`;

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
    expect(workflow).not.toContain("cache: pnpm");
    expect(workflow).toContain("apps/desktop/out/latest*.yml");
    expect(workflow).not.toContain("apps/desktop/out/*.yml");
  });

  it("notarizes macOS with a short-lived App Store Connect API key file", () => {
    for (const secret of ["APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_API_KEY_P8"]) {
      expect(workflow).toContain(`secrets.${secret}`);
    }
    expect(workflow).not.toMatch(/secrets\.(?:APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD)\b/);
    // The same temp path is declared by the setup, packaging, and cleanup steps.
    const keyFile = `APPLE_API_KEY: ${expression("runner.temp")}/apple-api-key.p8`;
    expect(workflow.split(keyFile)).toHaveLength(4);
    expect(workflow).toContain(`printf '%s\\n' "$APPLE_API_KEY_P8" > "$APPLE_API_KEY"`);
    expect(workflow).toContain('chmod 600 "$APPLE_API_KEY"');
    expect(workflow).toMatch(
      /if: always\(\) && runner\.os == 'macOS'\n(?:.*\n){3}\s+run: rm -f "\$APPLE_API_KEY"/,
    );
  });

  it("builds Windows only when an Authenticode certificate is configured", () => {
    expect(workflow).toContain(
      `WINDOWS_SIGNING: ${expression("secrets.DESKTOP_WIN_CSC_LINK != ''")}`,
    );
    expect(workflow).toContain(
      `include: ${expression("fromJSON(needs.validate.outputs.platforms)")}`,
    );
    expect(workflow).toContain(
      `include='[{"os":"macos-14","artifact":"macos"},{"os":"ubuntu-24.04","artifact":"linux"}]'`,
    );
    expect(workflow).toMatch(
      /if \[\[ "\$WINDOWS_SIGNING" == "true" \]\]; then\n\s+include=.*\{"os":"windows-2022","artifact":"windows"\}/,
    );
    expect(workflow.split("windows-2022")).toHaveLength(2);
    expect(workflow).toContain(`WINDOWS_BUILT: ${expression("needs.validate.outputs.windows")}`);
    expect(workflow).toContain('if [[ "$WINDOWS_BUILT" == "true" ]]; then');
    expect(workflow).toContain("feeds+=(release-artifacts/latest.yml)");
  });

  it("pins every platform update feed to the official GitHub owner and repo", () => {
    expect(workflow).toContain('grep -Fqx "provider: github"');
    expect(workflow).toContain('grep -Fqx "owner: elie222"');
    expect(workflow).toContain('grep -Fqx "repo: rakazo"');
    expect(workflow).toContain("Verify Linux update feed is pinned to the official GitHub channel");
    expect(workflow).toContain("Windows update config missing");
    expect(workflow).toContain("RELEASE_VERSION:");
    expect(workflow).toContain('grep -Fqx "version: $RELEASE_VERSION"');
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
