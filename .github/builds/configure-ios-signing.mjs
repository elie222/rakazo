import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Use the parser already used by Expo prebuild, without adding another dependency.
const mobileRequire = createRequire(path.resolve("apps/mobile/package.json"));
const expoRequire = createRequire(mobileRequire.resolve("expo/config-plugins"));
const pluginRequire = createRequire(expoRequire.resolve("@expo/config-plugins"));
const xcode = pluginRequire("xcode");
const signing = JSON.parse(readFileSync(process.argv[2], "utf8"));
const file = "apps/mobile/ios/BotONE.xcodeproj/project.pbxproj";
const project = xcode.project(file);
project.parseSync();
const found = new Set();
for (const entry of Object.values(project.pbxXCBuildConfigurationSection())) {
  const settings = entry.buildSettings;
  if (!settings?.PRODUCT_BUNDLE_IDENTIFIER) continue;
  const identifier = settings.PRODUCT_BUNDLE_IDENTIFIER.replaceAll('"', "");
  const profile = signing.profiles[identifier];
  if (!profile) throw new Error("An iOS target has no matching distribution profile.");
  found.add(identifier);
  Object.assign(settings, {
    CODE_SIGN_STYLE: "Manual",
    CODE_SIGN_IDENTITY: `"${signing.identity}"`,
    DEVELOPMENT_TEAM: signing.team,
    PROVISIONING_PROFILE_SPECIFIER: `"${profile}"`,
  });
}
if (found.size !== Object.keys(signing.profiles).length) {
  throw new Error("The generated iOS project is missing an expected signed target.");
}
writeFileSync(file, project.writeSync());
