const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { IOSConfig, withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const ICONS = path.join(__dirname, "..", "assets", "app-icons");
// The App Store only shows the primary icon, so alternates ship at the sizes a device draws
// and no 1024px copy: each one then costs about 100 KB of a thinned install.
const SIZES = [
  ["iphone", "20x20", 2],
  ["iphone", "20x20", 3],
  ["iphone", "29x29", 2],
  ["iphone", "29x29", 3],
  ["iphone", "40x40", 2],
  ["iphone", "40x40", 3],
  ["iphone", "60x60", 2],
  ["iphone", "60x60", 3],
  ["ipad", "20x20", 1],
  ["ipad", "20x20", 2],
  ["ipad", "29x29", 1],
  ["ipad", "29x29", 2],
  ["ipad", "40x40", 1],
  ["ipad", "40x40", 2],
  ["ipad", "76x76", 1],
  ["ipad", "76x76", 2],
  ["ipad", "83.5x83.5", 2],
];

/** Every icon but the primary one, which the app's own icon setting provides. */
function alternateIcons() {
  return fs
    .readdirSync(ICONS)
    .filter((file) => file.endsWith(".png") && file !== "default.png")
    .map((file) => file.slice(0, -4))
    .sort();
}

function iconSetName(icon) {
  return `AppIcon-${icon}`;
}

function iconSetImages() {
  return SIZES.map(([idiom, size, scale]) => ({
    filename: `${idiom}-${size}@${scale}x.png`,
    idiom,
    size,
    scale: `${scale}x`,
    pixels: Math.round(Number.parseFloat(size) * scale),
  }));
}

async function writeIconSets(assetCatalog, projectRoot) {
  // Expo's own icon pipeline, so prebuild needs no image library of its own.
  const { generateImageAsync } = createRequire(require.resolve("expo/package.json"))(
    "@expo/image-utils",
  );
  const images = iconSetImages();
  for (const icon of alternateIcons()) {
    const directory = path.join(assetCatalog, `${iconSetName(icon)}.appiconset`);
    fs.mkdirSync(directory, { recursive: true });
    for (const image of images) {
      const { source } = await generateImageAsync(
        { projectRoot, cacheType: "rakazo-app-icons" },
        {
          src: path.join(ICONS, `${icon}.png`),
          width: image.pixels,
          height: image.pixels,
          resizeMode: "cover",
          removeTransparency: true,
        },
      );
      fs.writeFileSync(path.join(directory, image.filename), source);
    }
    fs.writeFileSync(
      path.join(directory, "Contents.json"),
      `${JSON.stringify(
        {
          images: images.map(({ filename, idiom, size, scale }) => ({
            filename,
            idiom,
            size,
            scale,
          })),
          info: { author: "xcode", version: 1 },
        },
        null,
        2,
      )}\n`,
    );
  }
}

function withAlternateAppIcons(config) {
  config = withDangerousMod(config, [
    "ios",
    async (config) => {
      const { platformProjectRoot, projectRoot } = config.modRequest;
      const name = IOSConfig.XcodeUtils.getProjectName(projectRoot);
      await writeIconSets(path.join(platformProjectRoot, name, "Images.xcassets"), projectRoot);
      return config;
    },
  ]);
  return withXcodeProject(config, (config) => {
    setAlternateIconNames(
      config.modResults,
      IOSConfig.XcodeUtils.getProjectName(config.modRequest.projectRoot),
    );
    return config;
  });
}

/** Xcode lists these in the built Info.plist, which is what lets the app switch to them. */
function setAlternateIconNames(project, projectName) {
  // By name: the watch app is an application target too.
  const target = Object.values(project.pbxNativeTargetSection()).find(
    (candidate) =>
      typeof candidate === "object" && candidate.name?.replaceAll('"', "") === projectName,
  );
  if (!target) throw new Error(`Cannot find the ${projectName} target for alternate app icons.`);
  const list = project.hash.project.objects.XCConfigurationList[target.buildConfigurationList];
  const settings = project.pbxXCBuildConfigurationSection();
  const names = alternateIcons().map(iconSetName).join(" ");
  for (const { value } of list.buildConfigurations) {
    settings[value].buildSettings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = `"${names}"`;
  }
  return project;
}

module.exports = withAlternateAppIcons;
module.exports.alternateIcons = alternateIcons;
module.exports.iconSetImages = iconSetImages;
module.exports.setAlternateIconNames = setAlternateIconNames;
