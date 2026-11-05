import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { addNotificationExtension } from "./with-agent-notifications.js";

const require = createRequire(import.meta.url);
const plugins = require.resolve("expo/config-plugins");
const expoRoot = dirname(require.resolve("expo/package.json"));
const xcode = createRequire(require.resolve("@expo/config-plugins", { paths: [dirname(plugins)] }))(
  "xcode",
);

it("embeds one notification extension whose version follows the app across prebuilds", () => {
  const directory = mkdtempSync(join(tmpdir(), "rakazo-notification-target-"));
  try {
    const file = join(directory, "project.pbxproj");
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
    const app = { ios: { bundleIdentifier: "test.example.app", buildNumber: "2" }, version: "1.0" };
    addNotificationExtension(project, directory, app);
    const count = Object.keys(project.pbxNativeTargetSection()).length;
    addNotificationExtension(project, directory, {
      ...app,
      ios: { ...app.ios, buildNumber: "3" },
      version: "1.1",
    });
    expect(Object.keys(project.pbxNativeTargetSection())).toHaveLength(count);
    const settings = Object.values(project.pbxXCBuildConfigurationSection()).filter(
      (entry) => entry.buildSettings?.PRODUCT_NAME?.replaceAll('"', "") === "AgentNotifications",
    );
    expect(settings.length).toBeGreaterThan(0);
    for (const entry of settings) {
      expect(entry.buildSettings).toMatchObject({
        MARKETING_VERSION: "1.1",
        CURRENT_PROJECT_VERSION: "3",
        CODE_SIGN_ENTITLEMENTS: "AgentNotifications/AgentNotifications.entitlements",
        INFOPLIST_FILE: "AgentNotifications/Info.plist",
      });
    }
    const written = project.writeSync();
    expect(written).toContain("AgentNotifications.appex in Copy Files");
    expect(
      readFileSync(join(directory, "AgentNotifications/NotificationService.swift"), "utf8"),
    ).toContain("UNNotificationServiceExtension");
    writeFileSync(file, written);
    expect(() => xcode.project(file).parseSync()).not.toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("lists the extension for EAS signing with the communication entitlement", () => {
  const app = JSON.parse(readFileSync(join(__dirname, "..", "app.json"), "utf8")).expo;
  const extension = app.extra.eas.build.experimental.ios.appExtensions.find(
    (entry) => entry.targetName === "AgentNotifications",
  );
  expect(extension).toEqual({
    targetName: "AgentNotifications",
    bundleIdentifier: `${app.ios.bundleIdentifier}.notifications`,
    entitlements: { "com.apple.developer.usernotifications.communication": true },
  });
  expect(app.ios.entitlements["com.apple.developer.usernotifications.communication"]).toBe(true);
});

it("gives the extension its own Info.plist reference and a bundle name", () => {
  const directory = mkdtempSync(join(tmpdir(), "rakazo-notification-plist-"));
  try {
    const file = join(directory, "project.pbxproj");
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
    // Another extension's group already holds a file named Info.plist, as the widget's does.
    const widget = project.addPbxGroup(["Info.plist"], "Widget", "Widget");
    addNotificationExtension(project, directory, { ios: { bundleIdentifier: "test.example.app" } });
    const groups = Object.values(project.hash.project.objects.PBXGroup).filter(
      (group) => typeof group === "object",
    );
    const notifications = groups.find((group) => group.name === "AgentNotifications");
    const plist = notifications.children.find((child) => child.comment === "Info.plist");
    expect(plist.value).not.toBe(widget.pbxGroup.children[0].value);
    const members = groups.filter((group) =>
      group.children?.some((child) => child.value === plist.value),
    );
    expect(members).toHaveLength(1);
    expect(readFileSync(join(directory, "AgentNotifications/Info.plist"), "utf8")).toContain(
      "<key>CFBundleName</key>",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
