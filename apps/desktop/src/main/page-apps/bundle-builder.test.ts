import { describe, expect, it } from "vitest";
import { helperInfo, pageAppInfo } from "./bundle-builder.js";

describe("pageAppInfo", () => {
  it("gives the app its own name, identity and icon, and drops Rakazo's links and asset icon", () => {
    const info = pageAppInfo(
      {
        CFBundleExecutable: "Rakazo",
        CFBundleName: "Rakazo",
        CFBundleIdentifier: "dev.rakazo.desktop",
        CFBundleIconName: "Icon",
        CFBundleIconFile: "icon.icns",
        CFBundleURLTypes: [{ CFBundleURLSchemes: ["rakazo"] }],
        CFBundleShortVersionString: "0.16.0",
        ElectronAsarIntegrity: { "Resources/app.asar": { hash: "abc" } },
      },
      "Deal Tracker",
      "dev.rakazo.page-app.app1",
    );
    expect(info).toEqual({
      CFBundleExecutable: "Deal Tracker",
      CFBundleName: "Deal Tracker",
      CFBundleDisplayName: "Deal Tracker",
      CFBundleIdentifier: "dev.rakazo.page-app.app1",
      CFBundleIconFile: "icon.icns",
      CFBundleShortVersionString: "0.16.0",
      ElectronAsarIntegrity: { "Resources/app.asar": { hash: "abc" } },
    });
  });
});

describe("helperInfo", () => {
  it("names a helper after the app and moves its identifier under the app's", () => {
    expect(
      helperInfo(
        {
          CFBundleExecutable: "Rakazo Helper (GPU)",
          CFBundleIdentifier: "dev.rakazo.desktop.helper.GPU",
        },
        "Deal Tracker Helper (GPU)",
        "dev.rakazo.desktop",
        "dev.rakazo.page-app.app1",
      ),
    ).toEqual({
      CFBundleExecutable: "Deal Tracker Helper (GPU)",
      CFBundleName: "Deal Tracker Helper (GPU)",
      CFBundleDisplayName: "Deal Tracker Helper (GPU)",
      CFBundleIdentifier: "dev.rakazo.page-app.app1.helper.GPU",
    });
  });
});
