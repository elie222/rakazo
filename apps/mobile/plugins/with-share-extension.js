const fs = require("node:fs");
const path = require("node:path");
const { withFinalizedMod, withXcodeProject } = require("expo/config-plugins");
const { giveGroupOwnFiles } = require("./pbx-group");

const TARGET = "expo-sharing-extension";
const DISPLAY_NAME = /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/;

/** Gives the extension the app's name, which iOS shows under the icon in the share sheet. */
function renameShareExtension(infoPlist, name) {
  if (!DISPLAY_NAME.test(infoPlist)) throw new Error(`${TARGET} Info.plist has no display name`);
  return infoPlist.replace(DISPLAY_NAME, (_, open, close) => `${open}${name}${close}`);
}

/** expo-sharing's group reuses another extension's `Info.plist` reference, which Xcode rejects. */
function separateShareExtensionFiles(project) {
  const groups = project.hash.project.objects.PBXGroup;
  const uuid = Object.keys(groups).find(
    (key) => typeof groups[key] === "object" && groups[key].path === TARGET,
  );
  if (!uuid) throw new Error(`${TARGET} group is missing`);
  giveGroupOwnFiles(project, uuid);
}

/**
 * Fixes two things in expo-sharing's iOS share extension. List it before `expo-sharing`:
 * mods run in reverse order, so its project mod then runs after expo-sharing adds the target.
 * The extension's Info.plist comes from a dangerous mod, which runs before every other mod.
 */
function withShareExtension(config) {
  config = withXcodeProject(config, (config) => {
    separateShareExtensionFiles(config.modResults);
    return config;
  });
  return withFinalizedMod(config, [
    "ios",
    (config) => {
      // expo-sharing names the extension after its target, "expo-sharing-extension".
      const file = path.join(config.modRequest.platformProjectRoot, TARGET, "Info.plist");
      fs.writeFileSync(file, renameShareExtension(fs.readFileSync(file, "utf8"), config.name));
      return config;
    },
  ]);
}

module.exports = withShareExtension;
module.exports.renameShareExtension = renameShareExtension;
module.exports.separateShareExtensionFiles = separateShareExtensionFiles;
