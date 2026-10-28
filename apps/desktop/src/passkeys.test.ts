import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { associatedPasskeyRpIds, PASSKEY_RP_ID, passkeyEntitlements } from "./passkeys.js";
import { RAKAZO_CLOUD_URL } from "./setup-config.js";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  build: { appId: string; mac: { entitlements: string; entitlementsInherit: string } };
};
const base = readFileSync(path.join(root, pkg.build.mac.entitlements), "utf8");

describe("associatedPasskeyRpIds", () => {
  const resourcesPath = "/Applications/Rakazo.app/Contents/Resources";
  const profile = "/Applications/Rakazo.app/Contents/embedded.provisionprofile";

  it("is the hosted server's domain", () => {
    expect(PASSKEY_RP_ID).toBe(new URL(RAKAZO_CLOUD_URL).hostname);
  });

  it("lists the hosted domain only for a packaged macOS app with an embedded profile", () => {
    const exists = (file: string) => file === profile;
    expect(
      associatedPasskeyRpIds({ platform: "darwin", packaged: true, resourcesPath, exists }),
    ).toEqual([PASSKEY_RP_ID]);
    expect(
      associatedPasskeyRpIds({
        platform: "darwin",
        packaged: true,
        resourcesPath,
        exists: () => false,
      }),
    ).toEqual([]);
    expect(
      associatedPasskeyRpIds({ platform: "darwin", packaged: false, resourcesPath, exists }),
    ).toEqual([]);
    expect(
      associatedPasskeyRpIds({ platform: "win32", packaged: true, resourcesPath, exists }),
    ).toEqual([]);
  });
});

describe("passkeyEntitlements", () => {
  it("adds the application identifier and webcredentials domain to the base entitlements", () => {
    const plist = passkeyEntitlements(base, "ABCDE12345", pkg.build.appId);
    expect(plist.startsWith(base.slice(0, base.lastIndexOf("</dict>")).trimEnd())).toBe(true);
    expect(plist).toContain(
      "<key>com.apple.application-identifier</key>\n    <string>ABCDE12345.dev.rakazo.desktop</string>",
    );
    expect(plist).toContain(
      `<key>com.apple.developer.associated-domains</key>\n    <array>\n      <string>webcredentials:${PASSKEY_RP_ID}</string>\n    </array>\n  </dict>\n</plist>`,
    );
  });

  it("keeps helpers on the base entitlements", () => {
    expect(pkg.build.mac.entitlementsInherit).toBe(pkg.build.mac.entitlements);
    expect(base).not.toContain("associated-domains");
    expect(base).not.toContain("application-identifier");
  });

  it("rejects a malformed team or bundle identifier", () => {
    expect(() => passkeyEntitlements(base, "", pkg.build.appId)).toThrow();
    expect(() => passkeyEntitlements(base, "abcde12345", pkg.build.appId)).toThrow();
    expect(() => passkeyEntitlements(base, "ABCDE12345</string>", pkg.build.appId)).toThrow();
    expect(() => passkeyEntitlements(base, "ABCDE12345", "dev rakazo")).toThrow();
    const derived = passkeyEntitlements(base, "ABCDE12345", pkg.build.appId);
    expect(() => passkeyEntitlements(derived, "ABCDE12345", pkg.build.appId)).toThrow();
  });
});
