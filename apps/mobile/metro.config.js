const { getDefaultConfig } = require("expo/metro-config");
const { resolveTypeScriptSource } = require("./metro-resolver");

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);
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
