const fs = require("node:fs");
const path = require("node:path");
const { IOSConfig, withInfoPlist, withXcodeProject } = require("expo/config-plugins");

const INTENTS = path.join(__dirname, "..", "ios-intents");
const WIDGETS = path.join(__dirname, "..", "ios-widgets");
const APP_FILES = [
  "RakazoIntents.swift",
  "VoiceMessageRecorder.swift",
  "VoiceMessageActivity.swift",
];
const WIDGET_TARGET = "RakazoWidgets";
const WIDGET_FILES = ["RakazoWidgets.swift", "VoiceMessageActivity.swift"];

/**
 * Adds the Shortcuts and Siri actions. App Intents must be compiled into the app target for
 * Shortcuts to find them, so the Swift files go there rather than into a local module's pod.
 * The app's default server is copied into Info.plist for a session that never chose one.
 *
 * Record Message shows a Live Activity while it listens, which needs a widget extension: the
 * activity's attributes are compiled into both, and the widget draws it.
 */
function withAppIntents(config) {
  config = withInfoPlist(config, (config) => {
    const plist = config.modResults;
    plist.RakazoDefaultApiBase = process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:3100";
    plist.NSSupportsLiveActivities = true;
    // Keeps the microphone, and so the app, running while a recorded message sends.
    plist.UIBackgroundModes = [...new Set([...(plist.UIBackgroundModes ?? []), "audio"])];
    return config;
  });

  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const root = config.modRequest.platformProjectRoot;
    const name = IOSConfig.XcodeUtils.getProjectName(config.modRequest.projectRoot);

    for (const file of APP_FILES) {
      fs.copyFileSync(path.join(INTENTS, file), path.join(root, name, file));
      const filepath = `${name}/${file}`;
      if (!project.hasFile(filepath)) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath, groupName: name, project });
      }
    }

    const widgetDir = path.join(root, WIDGET_TARGET);
    fs.cpSync(WIDGETS, widgetDir, { recursive: true });
    fs.copyFileSync(
      path.join(INTENTS, "VoiceMessageActivity.swift"),
      path.join(widgetDir, "VoiceMessageActivity.swift"),
    );
    if (!project.pbxTargetByName(WIDGET_TARGET)) addWidgetTarget(config, project);
    setWidgetBuildSettings(config, project);
    return config;
  });
}

function addWidgetTarget(config, project) {
  // addTarget makes the app depend on the extension, which needs these sections to exist.
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};
  const bundleId = `${config.ios?.bundleIdentifier}.widgets`;
  const target = project.addTarget(WIDGET_TARGET, "app_extension", WIDGET_TARGET, bundleId);
  const group = project.addPbxGroup(
    [...WIDGET_FILES, "Assets.xcassets", "Info.plist"],
    WIDGET_TARGET,
    WIDGET_TARGET,
  );
  project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
  project.addBuildPhase(WIDGET_FILES, "PBXSourcesBuildPhase", "Sources", target.uuid);
  project.addBuildPhase(["Assets.xcassets"], "PBXResourcesBuildPhase", "Resources", target.uuid);
  project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
}

/** Every run, so the extension's version keeps matching the app's. */
function setWidgetBuildSettings(config, project) {
  for (const entry of Object.values(project.pbxXCBuildConfigurationSection())) {
    // Quoted when the target was just added, bare when read back from an existing project.
    if (entry.buildSettings?.PRODUCT_NAME?.replaceAll('"', "") !== WIDGET_TARGET) continue;
    Object.assign(entry.buildSettings, {
      APPLICATION_EXTENSION_API_ONLY: "YES",
      CODE_SIGN_STYLE: "Automatic",
      CURRENT_PROJECT_VERSION: config.ios?.buildNumber ?? "1",
      GENERATE_INFOPLIST_FILE: "NO",
      INFOPLIST_FILE: `${WIDGET_TARGET}/Info.plist`,
      // Record Message needs iOS 18, and the widget only draws its activity.
      IPHONEOS_DEPLOYMENT_TARGET: "18.0",
      MARKETING_VERSION: config.version ?? "1.0",
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: '"1,2"',
    });
  }
}

module.exports = withAppIntents;
