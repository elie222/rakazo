const fs = require("node:fs");
const path = require("node:path");
const { IOSConfig, withAppDelegate, withXcodeProject } = require("expo/config-plugins");
const { addPbxGroupWithOwnFiles } = require("./pbx-group");

const TARGET = "RakazoWatch";
const WATCH = path.join(__dirname, "..", "ios-watch");
const RELAY = path.join(__dirname, "..", "native", "watch");
const SHARED = "WatchExchange.swift";

function withAppleWatch(config) {
  config = withAppDelegate(config, (config) => {
    const start = "    WatchRelay.shared.activate()";
    const anchor = "    return super.application(application, didFinishLaunchingWithOptions:";
    const delegate = config.modResults;
    if (!delegate.contents.includes(start)) {
      if (delegate.language !== "swift" || !delegate.contents.includes(anchor)) {
        throw new Error("Cannot add the Apple Watch relay to AppDelegate.");
      }
      delegate.contents = delegate.contents.replace(anchor, `${start}\n${anchor}`);
    }
    return config;
  });

  return withXcodeProject(config, (config) => {
    const { platformProjectRoot: root, projectRoot } = config.modRequest;
    const name = IOSConfig.XcodeUtils.getProjectName(projectRoot);
    addWatchTarget(config.modResults, root, name, config);
    return config;
  });
}

function addWatchTarget(project, root, name, config) {
  const directory = path.join(root, TARGET);
  fs.cpSync(WATCH, directory, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "..", "assets", "icon.png"),
    path.join(directory, "WatchAssets.xcassets", "AppIcon.appiconset", "app-icon.png"),
  );
  for (const file of [SHARED, "WatchRelay.swift", "WatchThread.swift"]) {
    fs.copyFileSync(path.join(file === SHARED ? WATCH : RELAY, file), path.join(root, name, file));
    const filepath = `${name}/${file}`;
    if (!project.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath, groupName: name, project });
    }
  }

  let uuid = Object.keys(project.pbxNativeTargetSection()).find(
    (id) => project.pbxNativeTargetSection()[id]?.name?.replaceAll?.('"', "") === TARGET,
  );
  if (!uuid) {
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};
    const target = project.addTarget(
      TARGET,
      "watch2_app",
      TARGET,
      `${config.ios.bundleIdentifier}.watchkitapp`,
    );
    uuid = target.uuid;
    // The library embeds it correctly but uses the legacy stub app product type.
    target.pbxNativeTarget.productType = '"com.apple.product-type.application"';
    const product = project.pbxFileReferenceSection()[target.pbxNativeTarget.productReference];
    product.explicitFileType = "wrapper.application";
    const group = addPbxGroupWithOwnFiles(project, ["WatchAssets.xcassets"], TARGET, TARGET);
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
    project.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", uuid);
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", uuid);
    project.addBuildPhase(["WatchAssets.xcassets"], "PBXResourcesBuildPhase", "Resources", uuid);
  }
  for (const filepath of [SHARED, "RakazoWatch.swift"]) {
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath,
      groupName: TARGET,
      project,
      targetUuid: uuid,
    });
  }

  const target = project.pbxNativeTargetSection()[uuid];
  const configurations =
    project.hash.project.objects.XCConfigurationList[target.buildConfigurationList];
  const settings = project.pbxXCBuildConfigurationSection();
  for (const { value } of configurations.buildConfigurations) {
    const build = settings[value].buildSettings;
    delete build.INFOPLIST_FILE;
    Object.assign(build, {
      ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon",
      CODE_SIGN_STYLE: "Automatic",
      CURRENT_PROJECT_VERSION: config.ios.buildNumber ?? "1",
      GENERATE_INFOPLIST_FILE: "YES",
      INFOPLIST_KEY_CFBundleDisplayName: config.name,
      INFOPLIST_KEY_WKCompanionAppBundleIdentifier: config.ios.bundleIdentifier,
      MARKETING_VERSION: config.version ?? "1.0",
      SDKROOT: "watchos",
      SUPPORTED_PLATFORMS: '"watchos watchsimulator"',
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: "4",
      WATCHOS_DEPLOYMENT_TARGET: "10.0",
    });
  }
}

module.exports = withAppleWatch;
module.exports.addWatchTarget = addWatchTarget;
