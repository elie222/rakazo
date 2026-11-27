import path from "node:path";
import { build } from "esbuild";
import { desktopLocaleCatalogFiles, emitDesktopLocaleCatalogs } from "./locale-catalogs.ts";

const root = path.resolve(import.meta.dirname, "..");

// Zod's main barrel re-exports all validation locales; the desktop main process only uses English.
const zodEnglishLocaleOnly = {
  name: "zod-english-locale-only",
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /[\\/]zod[\\/]v4[\\/]locales[\\/]index\.(?:js|cjs)$/ }, () => ({
      contents: 'export { default as en } from "./en.js";\n',
      loader: "js",
    }));
  },
};

const localeTags = await emitDesktopLocaleCatalogs(path.join(root, "dist", "locales"));

const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/main/main.ts"],
  outfile: path.join(root, "dist", "main.js"),
  bundle: true,
  charset: "utf8",
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  metafile: true,
  plugins: [zodEnglishLocaleOnly, desktopLocaleCatalogFiles(localeTags)],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  external: ["electron", "electron-updater", "koffi", "@sentry/electron"],
  // Only the release workflow's builds report errors; local and agent builds never do.
  define: {
    "process.env.RAKAZO_DESKTOP_RELEASE": JSON.stringify(process.env.RAKAZO_DESKTOP_RELEASE ?? ""),
    // Self-hosted builds associated with their own passkey domain (see src/main/auth/passkeys.ts).
    "process.env.RAKAZO_PASSKEY_RP_ID": JSON.stringify(process.env.RAKAZO_PASSKEY_RP_ID ?? ""),
  },
});

const leakedCatalogs = Object.keys(result.metafile.inputs).filter(
  (file) => file.includes("src/main/locales/") || file.endsWith("src/main/locale-catalogs.ts"),
);
if (leakedCatalogs.length > 0) {
  throw new Error(`desktop main.js includes locale catalogs:\n${leakedCatalogs.join("\n")}`);
}

// The entry Electron starts: turns on the compile cache, then loads the bundle above.
await build({
  absWorkingDir: root,
  entryPoints: ["src/main/launch.ts"],
  outfile: path.join(root, "dist", "launch.js"),
  platform: "node",
  format: "esm",
  target: "node24",
});
