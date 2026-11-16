// Android 14+ samples about 1% of launches with GWP-ASan. When it records a backtrace for memory
// Hermes frees, its frame-pointer walk can run off the end of a Hermes stack and crash the app at
// launch (facebook/hermes#2225). Remove this plugin once the Hermes that React Native pins includes
// facebook/hermes#1874 and software-mansion/react-native-reanimated#10959 is fixed.
const { withAndroidManifest } = require("expo/config-plugins");

function disableGwpAsan(manifest) {
  const app = manifest.application?.[0];
  if (!app) throw new Error("with-android-no-gwp-asan: the manifest has no <application>.");
  app.$["android:gwpAsanMode"] = "never";
  return manifest;
}

function withAndroidNoGwpAsan(config) {
  return withAndroidManifest(config, (cfg) => {
    disableGwpAsan(cfg.modResults.manifest);
    return cfg;
  });
}

module.exports = withAndroidNoGwpAsan;
module.exports.disableGwpAsan = disableGwpAsan;
