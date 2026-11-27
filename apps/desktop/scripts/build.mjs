import { build } from "esbuild";

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

await build({
  entryPoints: ["src/main/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  charset: "utf8",
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  plugins: [zodEnglishLocaleOnly],
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

// The entry Electron starts: turns on the compile cache, then loads the bundle above.
await build({
  entryPoints: ["src/main/launch.ts"],
  outfile: "dist/launch.js",
  platform: "node",
  format: "esm",
  target: "node24",
});
