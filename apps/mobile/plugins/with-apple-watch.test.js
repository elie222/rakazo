import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import config from "../app.json";
import { addWatchTarget } from "./with-apple-watch.js";

const require = createRequire(import.meta.url);
const plugins = require.resolve("expo/config-plugins");
const expoRoot = dirname(require.resolve("expo/package.json"));
const xcode = createRequire(require.resolve("@expo/config-plugins", { paths: [dirname(plugins)] }))(
  "xcode",
);

const NAME = "HelloWorld";

/** Adds the watch targets to Expo's template project, writes it, and adds them again on the result. */
function regenerate(directory) {
  const file = join(directory, "project.pbxproj");
  mkdirSync(join(directory, NAME));
  writeFileSync(
    file,
    execFileSync("tar", [
      "-xOf",
      join(expoRoot, "template.tgz"),
      "package/ios/HelloWorld.xcodeproj/project.pbxproj",
    ]),
  );
  const project = xcode.project(file);
  project.parseSync();
  addWatchTarget(project, directory, NAME, config.expo);
  writeFileSync(file, project.writeSync());
  const regenerated = xcode.project(file);
  regenerated.parseSync();
  addWatchTarget(regenerated, directory, NAME, config.expo);
  return regenerated;
}

it("embeds one watch app with the correct sources, icon, and companion identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "rakazo-watch-target-"));
  try {
    const regenerated = regenerate(directory);
    const { PBXCopyFilesBuildPhase, PBXNativeTarget } = regenerated.hash.project.objects;
    const [target] = Object.values(PBXNativeTarget).filter(
      (entry) => entry.name?.replaceAll('"', "") === "RakazoWatch",
    );
    expect(
      existsSync(
        join(
          directory,
          "RakazoWatch",
          "WatchAssets.xcassets",
          "AppIcon.appiconset",
          "app-icon.png",
        ),
      ),
    ).toBe(true);
    expect(target.productType).toBe('"com.apple.product-type.application"');
    const embed = Object.values(PBXCopyFilesBuildPhase).filter(
      (phase) => phase.name === '"Embed Watch Content"',
    );
    expect(embed).toHaveLength(1);
    expect(embed[0].files).toHaveLength(1);
    const sources = target.buildPhases.find(({ comment }) => comment === "Sources");
    expect(regenerated.hash.project.objects.PBXSourcesBuildPhase[sources.value].files).toHaveLength(
      4,
    );

    const watchSigning = config.expo.extra.eas.build.experimental.ios.appExtensions.find(
      ({ targetName }) => targetName === "RakazoWatch",
    );
    const settings = Object.values(regenerated.pbxXCBuildConfigurationSection()).filter(
      (entry) => entry.buildSettings?.PRODUCT_NAME?.replaceAll('"', "") === "RakazoWatch",
    );
    expect(settings).toHaveLength(2);
    for (const { buildSettings } of settings) {
      expect(buildSettings.INFOPLIST_KEY_WKCompanionAppBundleIdentifier).toBe(
        config.expo.ios.bundleIdentifier,
      );
      expect(buildSettings.PRODUCT_BUNDLE_IDENTIFIER.replaceAll('"', "")).toBe(
        watchSigning.bundleIdentifier,
      );
    }

    const bundleIdentifier = "com.example.rakazo-custom";
    addWatchTarget(regenerated, directory, NAME, {
      ...config.expo,
      ios: { ...config.expo.ios, bundleIdentifier },
    });
    for (const { buildSettings } of settings) {
      expect(buildSettings.INFOPLIST_KEY_WKCompanionAppBundleIdentifier).toBe(bundleIdentifier);
      expect(buildSettings.PRODUCT_BUNDLE_IDENTIFIER.replaceAll('"', "")).toBe(
        `${bundleIdentifier}.watchkitapp`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("embeds the complications in the watch app with their sources and shared App Group", () => {
  const directory = mkdtempSync(join(tmpdir(), "rakazo-watch-complications-"));
  try {
    const regenerated = regenerate(directory);
    const { PBXCopyFilesBuildPhase, PBXNativeTarget } = regenerated.hash.project.objects;
    const [target] = Object.values(PBXNativeTarget).filter(
      (entry) => entry.name?.replaceAll?.('"', "") === "RakazoWatch",
    );
    // Inside the watch app, never the iPhone app.
    const [complications] = Object.entries(PBXNativeTarget).filter(
      ([, entry]) => entry.name?.replaceAll?.('"', "") === "RakazoWatchComplications",
    );
    const [complicationsUuid, complicationsTarget] = complications;
    const productRef = complicationsTarget.productReference;
    const { PBXBuildFile, PBXTargetDependency } = regenerated.hash.project.objects;
    const embedding = Object.entries(PBXCopyFilesBuildPhase).filter(
      ([, phase]) =>
        typeof phase === "object" &&
        phase.files.some(({ value }) => PBXBuildFile[value].fileRef === productRef),
    );
    expect(embedding).toHaveLength(1);
    expect(target.buildPhases.map(({ value }) => value)).toContain(embedding[0][0]);
    expect(embedding[0][1].dstSubfolderSpec).toBe(13);
    expect(
      target.dependencies.some(
        ({ value }) => PBXTargetDependency[value].target === complicationsUuid,
      ),
    ).toBe(true);
    const complicationSources = complicationsTarget.buildPhases.find(
      ({ comment }) => comment === "Sources",
    );
    expect(
      regenerated.hash.project.objects.PBXSourcesBuildPhase[complicationSources.value].files,
    ).toHaveLength(2);
    const watchSigning = config.expo.extra.eas.build.experimental.ios.appExtensions.find(
      ({ targetName }) => targetName === "RakazoWatch",
    );
    const complicationSigning = config.expo.extra.eas.build.experimental.ios.appExtensions.find(
      ({ targetName }) => targetName === "RakazoWatchComplications",
    );
    for (const signing of [watchSigning, complicationSigning]) {
      expect(signing.entitlements["com.apple.security.application-groups"]).toEqual([
        `group.${config.expo.ios.bundleIdentifier}`,
      ]);
    }
    const complicationSettings = Object.values(regenerated.pbxXCBuildConfigurationSection()).filter(
      (entry) =>
        entry.buildSettings?.PRODUCT_NAME?.replaceAll('"', "") === "RakazoWatchComplications",
    );
    expect(complicationSettings).toHaveLength(2);
    for (const { buildSettings } of complicationSettings) {
      expect(buildSettings.PRODUCT_BUNDLE_IDENTIFIER.replaceAll('"', "")).toBe(
        complicationSigning.bundleIdentifier,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
