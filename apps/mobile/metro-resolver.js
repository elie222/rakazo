function resolveTypeScriptSource(context, moduleName, platform, resolveRequest) {
  const importer = context.originModulePath ?? "";
  const isTypeScriptImporter = /\.[cm]?tsx?$/.test(importer);

  if (isTypeScriptImporter && moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return resolveRequest(context, moduleName.slice(0, -3), platform);
    } catch {
      // Preserve Metro's normal resolution and error for real JavaScript imports.
    }
  }

  return resolveRequest(context, moduleName, platform);
}

module.exports = { resolveTypeScriptSource };
