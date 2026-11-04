// Android 14+ samples about 1% of launches with GWP-ASan. When it records a backtrace for memory
// Hermes frees, its frame-pointer walk can run off the end of a Hermes stack and crash the app at
// launch. Hermes's fix (facebook/hermes#1874) is not in the version this React Native pins.
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function withAndroidNoGwpAsan(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (!app) throw new Error("with-android-no-gwp-asan: the manifest has no <application>.");
    app.$["android:gwpAsanMode"] = "never";
    return cfg;
  });
};
