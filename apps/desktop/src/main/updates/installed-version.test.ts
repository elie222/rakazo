import { describe, expect, it } from "vitest";
import { plistVersion } from "./installed-version.js";

describe("plistVersion", () => {
  it("reads the short version from an app's Info.plist", () => {
    const plist = `<dict>
    <key>CFBundleShortVersionString</key>
    <string>0.16.0</string>
    <key>CFBundleVersion</key>
    <string>0.16.0.1</string>
</dict>`;
    expect(plistVersion(plist)).toBe("0.16.0");
  });
});
