const fs = require("node:fs");
const path = require("node:path");
const { withXcodeProject } = require("expo/config-plugins");
const { addPbxGroupWithOwnFiles } = require("./pbx-group");

const TARGET = "AgentNotifications";
const SOURCE = path.join(__dirname, "..", "native", "notifications", "NotificationService.swift");
const ENTITLEMENT = "com.apple.developer.usernotifications.communication";

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Rakazo</string>
<key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
<key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
<key>CFBundlePackageType</key><string>XPC!</string>
<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
<key>NSExtension</key><dict>
<key>NSExtensionPointIdentifier</key><string>com.apple.usernotifications.service</string>
<key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).NotificationService</string>
</dict></dict></plist>
`;

const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>${ENTITLEMENT}</key><true/></dict></plist>
`;

/**
 * Adds a notification service extension that turns a push carrying a sender into a
 * communication notification, so iOS shows the agent's name and portrait.
 */
function addNotificationExtension(project, root, config) {
  const directory = path.join(root, TARGET);
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(SOURCE, path.join(directory, "NotificationService.swift"));
  fs.writeFileSync(path.join(directory, "Info.plist"), INFO_PLIST);
  fs.writeFileSync(path.join(directory, `${TARGET}.entitlements`), ENTITLEMENTS);

  // Quoted when the target was just added, bare when read back from an existing project.
  const existing = Object.values(project.pbxNativeTargetSection()).some(
    (target) => typeof target === "object" && target.name?.replaceAll('"', "") === TARGET,
  );
  if (!existing) {
    // addTarget makes the app depend on the extension, which needs these sections to exist.
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};
    const bundleId = `${config.ios?.bundleIdentifier}.notifications`;
    const target = project.addTarget(TARGET, "app_extension", TARGET, bundleId);
    const group = addPbxGroupWithOwnFiles(
      project,
      ["NotificationService.swift", "Info.plist", `${TARGET}.entitlements`],
      TARGET,
      TARGET,
    );
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
    project.addBuildPhase(
      ["NotificationService.swift"],
      "PBXSourcesBuildPhase",
      "Sources",
      target.uuid,
    );
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
  }

  // Every run, so the extension's version keeps matching the app's.
  for (const entry of Object.values(project.pbxXCBuildConfigurationSection())) {
    if (entry.buildSettings?.PRODUCT_NAME?.replaceAll('"', "") !== TARGET) continue;
    Object.assign(entry.buildSettings, {
      APPLICATION_EXTENSION_API_ONLY: "YES",
      CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
      CODE_SIGN_STYLE: "Automatic",
      CURRENT_PROJECT_VERSION: config.ios?.buildNumber ?? "1",
      GENERATE_INFOPLIST_FILE: "NO",
      INFOPLIST_FILE: `${TARGET}/Info.plist`,
      IPHONEOS_DEPLOYMENT_TARGET: "16.0",
      MARKETING_VERSION: config.version ?? "1.0",
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: '"1,2"',
    });
  }
}

function withAgentNotifications(config) {
  return withXcodeProject(config, (config) => {
    addNotificationExtension(config.modResults, config.modRequest.platformProjectRoot, config);
    return config;
  });
}

module.exports = withAgentNotifications;
module.exports.addNotificationExtension = addNotificationExtension;
