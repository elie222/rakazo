import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import withAgentNotifications, { addTarget } from "./with-agent-notifications.js";

const require = createRequire(import.meta.url);
const plugins = require.resolve("expo/config-plugins");
const expoRoot = dirname(require.resolve("expo/package.json"));
const xcode = createRequire(require.resolve("@expo/config-plugins", { paths: [dirname(plugins)] }))(
  "xcode",
);

it("generates and embeds one notification extension, with signing metadata that survives prebuild updates", () => {
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
    addTarget(project, directory, "test.example.app", "1.0", "2");
    const first = Object.values(project.pbxNativeTargetSection()).find(
      (target) =>
        typeof target === "object" && target.name?.replace(/^"|"$/g, "") === "AgentNotifications",
    );
    expect(first).toBeTruthy();
    const count = Object.keys(project.pbxNativeTargetSection()).length;
    addTarget(project, directory, "test.example.app", "1.1", "3");
    expect(Object.keys(project.pbxNativeTargetSection())).toHaveLength(count);
    const config = project.pbxXCConfigurationList()[first.buildConfigurationList];
    for (const entry of config.buildConfigurations) {
      expect(project.pbxXCBuildConfigurationSection()[entry.value].buildSettings).toMatchObject({
        APPLICATION_EXTENSION_API_ONLY: "YES",
        MARKETING_VERSION: "1.1",
        CURRENT_PROJECT_VERSION: "3",
        CODE_SIGN_ENTITLEMENTS: '"AgentNotifications/AgentNotifications.entitlements"',
      });
    }
    const host = project.getFirstTarget().firstTarget;
    expect(host.dependencies.length).toBeGreaterThan(0);
    expect(project.writeSync()).toContain("AgentNotifications.appex in Copy Files");
    expect(
      readFileSync(join(directory, "AgentNotifications/NotificationService.swift"), "utf8"),
    ).toContain("UNNotificationServiceExtension");
    writeFileSync(file, project.writeSync());
    expect(() => xcode.project(file).parseSync()).not.toThrow();
    const result = withAgentNotifications({
      name: "Test",
      slug: "test",
      ios: { bundleIdentifier: "test.example.app" },
    });
    expect(result.extra.eas.build.experimental.ios.appExtensions).toEqual([
      {
        targetName: "AgentNotifications",
        bundleIdentifier: "test.example.app.notifications",
        entitlements: { "com.apple.developer.usernotifications.communication": true },
      },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
