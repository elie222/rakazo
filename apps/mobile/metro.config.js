const { getSentryExpoConfig } = require("@sentry/react-native/metro");
const { resolveTypeScriptSource } = require("./metro-resolver");

const projectRoot = __dirname;
const config = getSentryExpoConfig(projectRoot);
// Translation catalogs are `.po` files that Lingui compiles as they load; every other file goes
// through Sentry's transformer as before.
process.env.RAKAZO_UPSTREAM_BABEL_TRANSFORMER = config.transformer.babelTransformerPath;
config.transformer.babelTransformerPath = require.resolve("./metro-transformer");
config.resolver.sourceExts = [...config.resolver.sourceExts, "po"];
const defaultResolveRequest = config.resolver.resolveRequest;
const pinned = new Set(["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-native"]);

function resolveFromApp(moduleName) {
  return require.resolve(moduleName, { paths: [projectRoot] });
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (pinned.has(moduleName) || moduleName.startsWith("react-native/")) {
    try {
      return { type: "sourceFile", filePath: resolveFromApp(moduleName) };
    } catch {
      // Fall through to Metro if this exact subpath is not in the app tree.
    }
  }
  if (defaultResolveRequest) {
    return resolveTypeScriptSource(context, moduleName, platform, defaultResolveRequest);
  }
  return resolveTypeScriptSource(context, moduleName, platform, context.resolveRequest);
};

module.exports = config;
