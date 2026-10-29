const fs = require("node:fs");
const path = require("node:path");
const { IOSConfig, withInfoPlist, withXcodeProject } = require("expo/config-plugins");

const SOURCE = path.join(__dirname, "..", "ios-intents", "RakazoIntents.swift");
const FILE_NAME = path.basename(SOURCE);

/**
 * Adds the Shortcuts and Siri actions. App Intents must be compiled into the app target for
 * Shortcuts to find them, so the Swift file goes there rather than into a local module's pod.
 * The app's default server is copied into Info.plist for a session that never chose one.
 */
function withAppIntents(config) {
  config = withInfoPlist(config, (config) => {
    config.modResults.RakazoDefaultApiBase =
      process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:3100";
    return config;
  });

  return withXcodeProject(config, (config) => {
    const name = IOSConfig.XcodeUtils.getProjectName(config.modRequest.projectRoot);
    fs.copyFileSync(SOURCE, path.join(config.modRequest.platformProjectRoot, name, FILE_NAME));
    const filepath = `${name}/${FILE_NAME}`;
    if (!config.modResults.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath,
        groupName: name,
        project: config.modResults,
      });
    }
    return config;
  });
}

module.exports = withAppIntents;
