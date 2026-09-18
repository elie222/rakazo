import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { applySceneLifecycleToAppDelegate, applySceneManifest } from "./with-scene-lifecycle.js";

const require = createRequire(import.meta.url);
const expoTemplateTgz = join(dirname(require.resolve("expo/package.json")), "template.tgz");
// The plugin matches exact Expo AppDelegate text. Read the pinned package's
// prebuild template so a patch bump fails here instead of at iOS prebuild.
const TEMPLATE = execFileSync(
  "tar",
  ["-xOf", expoTemplateTgz, "package/ios/HelloWorld/AppDelegate.swift"],
  { encoding: "utf8" },
);

describe("applySceneLifecycleToAppDelegate", () => {
  it("hands window creation to Expo's scene delegate", () => {
    const result = applySceneLifecycleToAppDelegate(TEMPLATE);

    // The app delegate only provides the factory; the scene manifest routes
    // to Expo's EXExpoAppSceneDelegate, so no window code stays behind.
    expect(result).toContain(
      "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {",
    );
    expect(result).toContain("let factory = ExpoReactNativeFactory(delegate: delegate)");
    expect(result).not.toContain("UIWindow(frame: UIScreen.main.bounds)");
    expect(result).not.toContain("startReactNative(");
    expect(result).not.toContain("class SceneDelegate");
    // Pre-existing template behavior is untouched.
    expect(result).toContain("RCTLinkingManager.application(app, open: url, options: options)");
    expect(result).toContain("class ReactNativeDelegate: ExpoReactNativeFactoryDelegate");
  });

  it("is idempotent", () => {
    const once = applySceneLifecycleToAppDelegate(TEMPLATE);
    expect(applySceneLifecycleToAppDelegate(once)).toBe(once);
  });

  it("fails loudly when the Expo template drifts", () => {
    expect(() => applySceneLifecycleToAppDelegate("class AppDelegate: ExpoAppDelegate {}")).toThrow(
      /template changed/,
    );
  });

  it("fails loudly when only one anchor survives template drift", () => {
    const noLaunchingBlock = TEMPLATE.replace(/#if os\(iOS\)[\s\S]*?#endif\n\n/, "");
    expect(() => applySceneLifecycleToAppDelegate(noLaunchingBlock)).toThrow(/template changed/);
  });

  it("refuses a partially migrated AppDelegate instead of skipping it", () => {
    const partial = TEMPLATE.replace(
      "class AppDelegate: ExpoAppDelegate {",
      "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {",
    );
    expect(() => applySceneLifecycleToAppDelegate(partial)).toThrow(/refusing to guess/);
  });
});

describe("applySceneManifest", () => {
  it("declares a single-scene manifest pointing at Expo's scene delegate", () => {
    const infoPlist = applySceneManifest({});

    expect(infoPlist.UIApplicationSceneManifest).toEqual({
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "main",
            UISceneDelegateClassName: "EXExpoAppSceneDelegate",
          },
        ],
      },
    });
  });
});
