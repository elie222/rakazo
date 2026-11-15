// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: CI packaging runs directly, outside Turbo.
const { build } = require("../../apps/desktop/package.json");
const { releaseIdentifier, releaseServer } = require("./release-config.mjs");

module.exports = {
  ...build,
  productName: "BotONE",
  appId: releaseIdentifier(process.env.BOTONE_DESKTOP_APP_ID),
  extraMetadata: {
    ...build.extraMetadata,
    name: "botone",
    productName: "BotONE",
    defaultServerUrl: releaseServer(process.env.EXPO_PUBLIC_API_URL),
  },
  // Independent downloads must never inherit the upstream automatic update channel.
  publish: null,
  forceCodeSigning: true,
  mac: {
    ...build.mac,
    hardenedRuntime: true,
    notarize: true,
    // These clients connect to the configured server; no upstream server bundle is shipped.
    extraResources: build.mac.extraResources.filter((item) => item.to !== "server-bundle.json"),
  },
};
