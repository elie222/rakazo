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
    expect(workflow).toContain('RAKAZO_DESKTOP_RELEASE: "1"');
    expect(workflow).toContain("-c.forceCodeSigning=true");
    expect(workflow).toContain("codesign --verify --deep --strict");
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain("needs: [validate, build]");
    expect(workflow).toContain("attestations: write");
    expect(workflow).toContain("actions/attest-build-provenance@");
    expect(workflow).not.toContain("--publish always");
    expect(workflow).toContain("DESKTOP_MAC_CSC_LINK");
    expect(workflow).not.toContain("DESKTOP_WIN_CSC");
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

  it("always builds Windows and signs it once Azure Artifact Signing is configured", () => {
    expect(workflow).toContain(
      `WINDOWS_SIGNING: ${expression("secrets.DESKTOP_WIN_AZURE_CLIENT_ID != ''")}`,
    );
    expect(workflow).not.toContain("AZURE_CLIENT_SECRET");
    expect(workflow).toContain("environment: desktop-release");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("azure/login@");
    expect(workflow).toContain("TimeStamperCertificate");
    expect(workflow).toContain(
      "if: runner.os == 'Windows' && needs.validate.outputs.windows_signed == 'true'",
    );
    expect(workflow).toContain(
      "if: runner.os == 'Windows' && needs.validate.outputs.windows_signed != 'true'",
    );
    expect(workflow).toContain("Unsigned Windows update config names a publisher.");
    for (const option of [
      "endpoint",
      "codeSigningAccountName",
      "certificateProfileName",
      "publisherName",
    ]) {
      expect(workflow).toContain(`"-c.win.azureSignOptions.${option}=$`);
    }
    expect(workflow).toContain("is not signed by the configured publisher");
    expect(workflow).toContain(
      `include: ${expression("fromJSON(needs.validate.outputs.platforms)")}`,
    );
    expect(workflow).toContain(
      `include='[{"os":"macos-26","artifact":"macos"},{"os":"ubuntu-24.04","artifact":"linux"},{"os":"windows-2022","artifact":"windows"}]'`,
    );
    expect(workflow.split("windows-2022")).toHaveLength(2);
    expect(workflow).toContain("test -f release-artifacts/latest.yml");
    expect(workflow).toContain("compgen -G 'release-artifacts/*.exe' >/dev/null");
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

  it("adds the system passkey association only when a provisioning profile is configured", () => {
    expect(workflow).toContain(
      `PROVISIONING_PROFILE: ${expression("secrets.DESKTOP_MAC_PROVISIONING_PROFILE")}`,
    );
    expect(workflow).toMatch(/if \[\[ -z "\$PROVISIONING_PROFILE" \]\]; then\n.*\n\s+exit 0/);
    expect(workflow).toContain("pnpm exec tsx apps/desktop/scripts/passkey-entitlements.ts");
    expect(workflow).toContain('if [[ "$app_id" != "$APPLE_TEAM_ID.$bundle_id" ]]; then');
    // Helpers keep entitlementsInherit; only the main app is associated.
    expect(workflow).toContain(
      '"-c.mac.entitlements=$PASSKEY_ENTITLEMENTS" "-c.mac.provisioningProfile=$PASSKEY_PROFILE"',
    );
    expect(workflow).not.toContain("entitlementsInherit=");
    expect(workflow).toContain('test -f "$app/Contents/embedded.provisionprofile"');
    expect(workflow).not.toMatch(/secrets\.APPLE_TEAM_ID/);
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
