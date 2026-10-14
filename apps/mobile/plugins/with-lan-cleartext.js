// Lets release builds reach a self-hosted server over http:// on the LAN.
// JS (lib/endpoint.ts) already refuses http:// for public hosts.
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function withLanCleartext(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) app.$["android:usesCleartextTraffic"] = "true";
    return cfg;
  });
};
