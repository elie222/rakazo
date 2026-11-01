const fs = require("node:fs");
const path = require("node:path");
const {
  withXcodeProject,
  withEntitlementsPlist,
  withInfoPlist,
  withAndroidManifest,
} = require("expo/config-plugins");

const TARGET = "AgentNotifications";

function addTarget(project, root, bundleIdentifier, version, buildNumber) {
  project.hash.project.objects.PBXTargetDependency ??= {};
  project.hash.project.objects.PBXContainerItemProxy ??= {};
  const existing = Object.values(project.pbxNativeTargetSection()).find(
    (target) => typeof target === "object" && target.name?.replace(/^"|"$/g, "") === TARGET,
  );
  const directory = path.join(root, TARGET);
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "../native/notifications/NotificationService.swift"),
    path.join(directory, "NotificationService.swift"),
  );
  fs.writeFileSync(
    path.join(directory, `${TARGET}-Info.plist`),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Rakazo</string>
<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
<key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
<key>CFBundlePackageType</key><string>XPC!</string>
<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
<key>NSExtension</key><dict>
<key>NSExtensionPointIdentifier</key><string>com.apple.usernotifications.service</string>
<key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).NotificationService</string>
</dict></dict></plist>`,
  );
  const target = existing
    ? { pbxNativeTarget: existing }
    : project.addTarget(TARGET, "app_extension", TARGET, `${bundleIdentifier}.notifications`);
  if (!existing) {
    project.addBuildPhase(
      [`${TARGET}/NotificationService.swift`],
      "PBXSourcesBuildPhase",
      "Sources",
      target.uuid,
    );
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
  }
  fs.writeFileSync(
    path.join(directory, `${TARGET}.entitlements`),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.developer.usernotifications.communication</key><true/></dict></plist>`,
  );
  const targetId = Object.entries(project.pbxNativeTargetSection()).find(
    ([, entry]) => entry === target.pbxNativeTarget,
  )?.[0];
  const host = project.getFirstTarget();
  const dependencies = project.hash.project.objects.PBXTargetDependency;
  if (
    !host.firstTarget.dependencies.some((entry) => dependencies[entry.value]?.target === targetId)
  ) {
    project.addTargetDependency(host.uuid, [targetId]);
  }
  const configurationList =
    project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList];
  for (const entry of configurationList.buildConfigurations) {
    const settings = project.pbxXCBuildConfigurationSection()[entry.value].buildSettings;
    Object.assign(settings, {
      CODE_SIGN_ENTITLEMENTS: `"${TARGET}/${TARGET}.entitlements"`,
      SWIFT_VERSION: "5.0",
      IPHONEOS_DEPLOYMENT_TARGET: "16.0",
      TARGETED_DEVICE_FAMILY: '"1,2"',
      APPLICATION_EXTENSION_API_ONLY: "YES",
      CODE_SIGN_STYLE: "Automatic",
      MARKETING_VERSION: version,
      CURRENT_PROJECT_VERSION: buildNumber,
    });
  }
}

module.exports = function withAgentNotifications(config) {
  config = withEntitlementsPlist(config, (mod) => {
    mod.modResults["com.apple.developer.usernotifications.communication"] = true;
    return mod;
  });
  config = withInfoPlist(config, (mod) => {
    mod.modResults.NSUserActivityTypes = [
      ...new Set([...(mod.modResults.NSUserActivityTypes ?? []), "INSendMessageIntent"]),
    ];
    return mod;
  });
  config = withXcodeProject(config, (mod) => {
    addTarget(
      mod.modResults,
      mod.modRequest.platformProjectRoot,
      mod.ios.bundleIdentifier,
      mod.version ?? "1.0",
      mod.ios.buildNumber ?? "1",
    );
    return mod;
  });
  config = withAndroidManifest(config, (mod) => {
    mod.modResults.manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
    const app = mod.modResults.manifest.application[0];
    app.service ??= [];
    if (
      !app.service.some(
        (service) =>
          service.$["android:name"] ===
          "expo.modules.notifications.service.ExpoFirebaseMessagingService",
      )
    ) {
      app.service.push({
        $: {
          "android:name": "expo.modules.notifications.service.ExpoFirebaseMessagingService",
          "tools:node": "remove",
        },
      });
    }
    return mod;
  });
  // EAS must provision the extension as well as the host app.
  const extensions = config.extra?.eas?.build?.experimental?.ios?.appExtensions ?? [];
  config.extra = {
    ...config.extra,
    eas: {
      ...config.extra?.eas,
      build: {
        ...config.extra?.eas?.build,
        experimental: {
          ...config.extra?.eas?.build?.experimental,
          ios: {
            ...config.extra?.eas?.build?.experimental?.ios,
            appExtensions: [
              ...extensions.filter((extension) => extension.targetName !== TARGET),
              {
                targetName: TARGET,
                bundleIdentifier: `${config.ios.bundleIdentifier}.notifications`,
                entitlements: { "com.apple.developer.usernotifications.communication": true },
              },
            ],
          },
        },
      },
    },
  };
  return config;
};
module.exports.addTarget = addTarget;
