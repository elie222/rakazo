// Runs R8 with optimization on Android release builds so Google Play sees shrunk, optimized,
// obfuscated code. The bundle then carries the mapping file Play uses to deobfuscate crashes.
const { withAppBuildGradle, withGradleProperties } = require("expo/config-plugins");

const MINIFY = "android.enableMinifyInReleaseBuilds";
// Expo's template names the default rules file that turns R8 optimization off (-dontoptimize).
const DEFAULT_RULES = 'getDefaultProguardFile("proguard-android.txt")';
const OPTIMIZE_RULES = 'getDefaultProguardFile("proguard-android-optimize.txt")';

function applyOptimizedRules(gradle) {
  if (gradle.includes(OPTIMIZE_RULES)) return gradle;
  if (!gradle.includes(DEFAULT_RULES)) {
    throw new Error("with-android-r8: app/build.gradle no longer names the default ProGuard file.");
  }
  return gradle.replace(DEFAULT_RULES, OPTIMIZE_RULES);
}

function withAndroidR8(config) {
  config = withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter(
      (item) => item.type !== "property" || item.key !== MINIFY,
    );
    cfg.modResults.push({ type: "property", key: MINIFY, value: "true" });
    return cfg;
  });
  return withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = applyOptimizedRules(cfg.modResults.contents);
    return cfg;
  });
}

module.exports = withAndroidR8;
module.exports.applyOptimizedRules = applyOptimizedRules;
