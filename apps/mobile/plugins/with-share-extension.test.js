import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { addNotificationExtension } from "./with-agent-notifications.js";
import { renameShareExtension, separateShareExtensionFiles } from "./with-share-extension.js";

const require = createRequire(import.meta.url);
const plugins = require.resolve("expo/config-plugins");
const expoRoot = dirname(require.resolve("expo/package.json"));
const xcode = createRequire(require.resolve("@expo/config-plugins", { paths: [dirname(plugins)] }))(
  "xcode",
);
// The pinned expo-sharing prebuild code, so a change to its templates fails here.
const sharing = (file) => require(`expo-sharing/plugin/build/ios/${file}`);

function withTemplateProject(run) {
  const directory = mkdtempSync(join(tmpdir(), "rakazo-share-extension-"));
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
    run(project, directory, file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it("names the pinned expo-sharing extension after the app", () => {
  withTemplateProject((_, directory) => {
    sharing("createInfoPlistFile").default(directory, "group.test.example", "example", {
      supportsText: true,
    });
    const original = readFileSync(join(directory, "Info.plist"), "utf8");
    expect(original).toContain("<string>$(PRODUCT_NAME)</string>");
    const renamed = renameShareExtension(original, "Rakazo");
    expect(renamed).toMatch(/<key>CFBundleDisplayName<\/key>\s*<string>Rakazo<\/string>/);
    // The bundle name and everything else are untouched.
    expect(renamed.replace("Rakazo", "$(PRODUCT_NAME)")).toBe(original);
  });
});

it("keeps the share extension's Info.plist out of the other extensions' groups", () => {
  withTemplateProject((project, directory, file) => {
    // Mods run in reverse order, so the app's own extensions are already in the project.
    addNotificationExtension(project, directory, { ios: { bundleIdentifier: "test.example.app" } });
    const files = sharing("setupShareExtensionFiles").parseDirectoryFiles(
      dirname(
        require.resolve("expo-sharing/plugin/template-files/ios/ShareIntoViewController.swift"),
      ),
    );
    sharing("xcode/addPbxGroup").addPbxGroup(project, "expo-sharing-extension", files, directory);
    separateShareExtensionFiles(project);

    const groups = Object.values(project.hash.project.objects.PBXGroup).filter(
      (group) => typeof group === "object",
    );
    const members = new Map();
    for (const group of groups)
      for (const child of group.children ?? [])
        members.set(child.value, (members.get(child.value) ?? 0) + 1);
    const share = groups.find((group) => group.path === "expo-sharing-extension");
    const plist = share.children.find((child) => child.comment === "Info.plist");
    expect(members.get(plist.value)).toBe(1);
    writeFileSync(file, project.writeSync());
    expect(() => xcode.project(file).parseSync()).not.toThrow();
  });
});
