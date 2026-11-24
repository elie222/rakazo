const fs = require("node:fs");
const path = require("node:path");
const { IOSConfig, withAppDelegate, withXcodeProject } = require("expo/config-plugins");
const { addPbxGroupWithOwnFiles } = require("./pbx-group");

const TARGET = "RakazoWatch";
const COMPLICATIONS = "RakazoWatchComplications";
const WATCH = path.join(__dirname, "..", "ios-watch");
const COMPLICATION_SOURCES = path.join(__dirname, "..", "ios-watch-complications");
const RELAY = path.join(__dirname, "..", "native", "watch");
const SHARED = "WatchExchange.swift";
/** Read by both the watch app and its complications. */
const SHELF = "WatchShelf.swift";
const WATCH_FILES = ["RakazoWatch.swift", "WatchVoice.swift", SHELF];

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
  const watchBundleIdentifier = `${config.ios.bundleIdentifier}.watchkitapp`;
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

  let uuid = findTarget(project, TARGET);
  if (!uuid) {
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};
    const target = project.addTarget(TARGET, "watch2_app", TARGET, watchBundleIdentifier);
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
  for (const filepath of [SHARED, ...WATCH_FILES]) {
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath,
      groupName: TARGET,
      project,
      targetUuid: uuid,
    });
  }

  const appGroup = `group.${config.ios.bundleIdentifier}`;
  writeEntitlements(directory, TARGET, appGroup);
  for (const build of targetBuildSettings(project, uuid)) {
    Object.assign(build, {
      ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon",
      CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
      CODE_SIGN_STYLE: "Automatic",
      CURRENT_PROJECT_VERSION: config.ios.buildNumber ?? "1",
      GENERATE_INFOPLIST_FILE: "YES",
      // Merged into the generated one: registers the link a complication opens.
      INFOPLIST_FILE: `${TARGET}/Info.plist`,
      INFOPLIST_KEY_CFBundleDisplayName: config.name,
      INFOPLIST_KEY_NSMicrophoneUsageDescription:
        '"Rakazo records your voice to send it as a message."',
      INFOPLIST_KEY_WKCompanionAppBundleIdentifier: config.ios.bundleIdentifier,
      MARKETING_VERSION: config.version ?? "1.0",
      PRODUCT_BUNDLE_IDENTIFIER: `"${watchBundleIdentifier}"`,
      SDKROOT: "watchos",
      SUPPORTED_PLATFORMS: '"watchos watchsimulator"',
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: "4",
      WATCHOS_DEPLOYMENT_TARGET: "10.0",
    });
  }
  addComplicationTarget(project, root, uuid, watchBundleIdentifier, appGroup, config);
}

/** The watch face complications: a WidgetKit extension embedded in the watch app. */
function addComplicationTarget(project, root, watchUuid, watchBundleIdentifier, appGroup, config) {
  const directory = path.join(root, COMPLICATIONS);
  fs.cpSync(COMPLICATION_SOURCES, directory, { recursive: true });
  fs.copyFileSync(path.join(WATCH, SHELF), path.join(directory, SHELF));
  writeEntitlements(directory, COMPLICATIONS, appGroup);

  let uuid = findTarget(project, COMPLICATIONS);
  if (!uuid) {
    const target = project.addTarget(
      COMPLICATIONS,
      "app_extension",
      COMPLICATIONS,
      `${watchBundleIdentifier}.complications`,
    );
    uuid = target.uuid;
    embedInWatchApp(project, target, watchUuid);
    const group = addPbxGroupWithOwnFiles(project, ["Info.plist"], COMPLICATIONS, COMPLICATIONS);
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
    project.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", uuid);
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", uuid);
    project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", uuid);
  }
  for (const filepath of ["RakazoComplications.swift", SHELF]) {
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath,
      groupName: COMPLICATIONS,
      project,
      targetUuid: uuid,
    });
  }
  for (const build of targetBuildSettings(project, uuid)) {
    Object.assign(build, {
      APPLICATION_EXTENSION_API_ONLY: "YES",
      CODE_SIGN_ENTITLEMENTS: `${COMPLICATIONS}/${COMPLICATIONS}.entitlements`,
      CODE_SIGN_STYLE: "Automatic",
      CURRENT_PROJECT_VERSION: config.ios.buildNumber ?? "1",
      GENERATE_INFOPLIST_FILE: "NO",
      INFOPLIST_FILE: `${COMPLICATIONS}/Info.plist`,
      MARKETING_VERSION: config.version ?? "1.0",
      PRODUCT_BUNDLE_IDENTIFIER: `"${watchBundleIdentifier}.complications"`,
      SDKROOT: "watchos",
      SKIP_INSTALL: "YES",
      SUPPORTED_PLATFORMS: '"watchos watchsimulator"',
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: "4",
      WATCHOS_DEPLOYMENT_TARGET: "10.0",
    });
  }
}

/**
 * The xcode library embeds every extension in the first target, the iPhone app, and may add it
 * to another extension's copy phase. Moves the product and the dependency to the watch app.
 */
function embedInWatchApp(project, target, watchUuid) {
  const objects = project.hash.project.objects;
  const product = target.pbxNativeTarget.productReference;
  let buildFile;
  for (const [key, phase] of Object.entries(objects.PBXCopyFilesBuildPhase)) {
    if (typeof phase !== "object") continue;
    const index = phase.files.findIndex(
      ({ value }) => project.pbxBuildFileSection()[value]?.fileRef === product,
    );
    if (index >= 0) [buildFile] = phase.files.splice(index, 1);
    if (
      phase.files.length === 0 &&
      objects.PBXCopyFilesBuildPhase[`${key}_comment`] === "Copy Files"
    ) {
      removeBuildPhase(project, key);
    }
  }
  const app = project.getFirstTarget().firstTarget;
  const dependency = app.dependencies.findIndex(
    ({ value }) => objects.PBXTargetDependency[value]?.target === target.uuid,
  );
  const [moved] = app.dependencies.splice(dependency, 1);
  project.pbxNativeTargetSection()[watchUuid].dependencies.push(moved);
  const embed = project.addBuildPhase(
    [],
    "PBXCopyFilesBuildPhase",
    // Not "Embed Foundation Extensions": expo-sharing finds the app's phase by that name.
    "Embed Watch Extensions",
    watchUuid,
    "app_extension",
  );
  embed.buildPhase.files.push(buildFile);
}

function removeBuildPhase(project, key) {
  const objects = project.hash.project.objects;
  delete objects.PBXCopyFilesBuildPhase[key];
  delete objects.PBXCopyFilesBuildPhase[`${key}_comment`];
  for (const target of Object.values(project.pbxNativeTargetSection())) {
    if (typeof target !== "object") continue;
    target.buildPhases = target.buildPhases.filter(({ value }) => value !== key);
  }
}

function findTarget(project, name) {
  return Object.keys(project.pbxNativeTargetSection()).find(
    (id) => project.pbxNativeTargetSection()[id]?.name?.replaceAll?.('"', "") === name,
  );
}

function targetBuildSettings(project, uuid) {
  const target = project.pbxNativeTargetSection()[uuid];
  const configurations =
    project.hash.project.objects.XCConfigurationList[target.buildConfigurationList];
  const settings = project.pbxXCBuildConfigurationSection();
  return configurations.buildConfigurations.map(({ value }) => settings[value].buildSettings);
}

/** Shares the App Group with the complications, which list the chats the watch app saved. */
function writeEntitlements(directory, target, appGroup) {
  fs.writeFileSync(
    path.join(directory, `${target}.entitlements`),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${appGroup}</string>
  </array>
</dict>
</plist>
`,
  );
}

module.exports = withAppleWatch;
module.exports.addWatchTarget = addWatchTarget;
