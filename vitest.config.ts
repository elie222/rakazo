import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lingui } from "@lingui/vite-plugin";
import { defineConfig } from "vitest/config";

const include = [
  ".agents/skills/*/*.test.ts",
  "packages/*/src/**/*.test.{ts,tsx}",
  "infra/sandboxes/supervisor/src/**/*.test.ts",
  "infra/updater/src/**/*.test.ts",
  "apps/desktop/src/**/*.test.ts",
  "apps/web/src/**/*.test.{ts,tsx}",
  "apps/web/server/**/*.test.ts",
  "apps/mobile/{lib,components}/**/*.test.{ts,tsx}",
  "apps/mobile/plugins/**/*.test.js",
  "apps/api/src/**/*.test.ts",
  "apps/worker/src/**/*.test.ts",
];

// Package scripts run from their own folder, so paths resolve from the repo root, not the cwd.
const root = path.dirname(fileURLToPath(import.meta.url));
// The slowest files start processes (shell scripts, CLIs, servers). CI runs them in their own job
// beside the unit shards, so they never set a shard's finish time. List a new one in
// vitest.processes.json when it takes more than a few seconds.
const processes: string[] = JSON.parse(
  readFileSync(path.join(root, "vitest.processes.json"), "utf8"),
);

// Files that mock modules, assign globals, or change the environment by hand keep a fresh module
// graph; the rest share one per worker, which skips re-importing the same modules for every file.
// Spies, stubbed envs and globals, and fake timers are undone before each test (see `test` below
// and pin-test-env.ts), so files that only use those share too.
// Files that replace prototype methods keep a fresh graph as well. The model catalog is built
// once per process from the model env vars, so files that stub them stay isolated too.
// Database runs give every file its own database, so they never share.
const mutatesSharedState =
  /vi\.(mock|doMock|resetModules)\(|globalThis\.\w+ *=[^=]|(globalThis|global|window)\[[^\]]+\] *=[^=]|process\.env(\.\w+|\[[^\]]+\]) *=[^=]|delete process\.env|defineProperty\((globalThis|global|window|document|navigator|process)|process\.chdir|@vitest-environment|\.prototype\.\w+ *=[^=]|stubEnv\(\s*["'`](RAKAZO_LOCAL_|RAKAZO_OPENAI_COMPATIBLE|PI_)/;
const isolated = include
  .flatMap((pattern) => globSync(pattern, { cwd: root }))
  .filter((file) => !processes.includes(file))
  .filter(
    (file) =>
      process.env.COPY_TEST_DATABASE ||
      mutatesSharedState.test(readFileSync(path.join(root, file), "utf8")),
  );

export default defineConfig({
  // Mobile imports its translation catalogs as `.po` files.
  // Some runs start outside the repo, so the config is named rather than searched for.
  plugins: [lingui({ configPath: path.join(root, "lingui.config.ts") })],
  resolve: {
    alias: [
      {
        // The published dist keeps JSX inside .js files, which vite cannot parse;
        // tests load the package's shipped TypeScript source instead.
        find: /^@ronradtke\/react-native-markdown-display$/,
        replacement: fileURLToPath(
          new URL(
            "./packages/chat-ui/node_modules/@ronradtke/react-native-markdown-display/src/index.tsx",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@lingui\/core\/macro$/,
        replacement: fileURLToPath(
          new URL("./packages/testkit/src/lingui-core-macro.ts", import.meta.url),
        ),
      },
      {
        find: /^@lingui\/react\/macro$/,
        replacement: fileURLToPath(
          new URL("./packages/testkit/src/lingui-react-macro.ts", import.meta.url),
        ),
      },
      {
        // A native view; tests see its Markdown as text.
        find: /^react-native-enriched-markdown$/,
        replacement: fileURLToPath(
          new URL("./packages/chat-ui/src/enriched-markdown-test-stub.tsx", import.meta.url),
        ),
      },
      // Native-only transitive deps of the renderer contain uncompiled Flow
      // source; stub them out in tests (they never render anyway).
      ...["react-native-fit-image", "@react-native-vector-icons/material-design-icons"].map(
        (dep) => ({
          find: new RegExp(`^${dep.replace(/[/]/g, "\\/")}$`),
          replacement: fileURLToPath(
            new URL("./packages/chat-ui/src/native-test-stubs.tsx", import.meta.url),
          ),
        }),
      ),
    ],
  },
  test: {
    // Load the markdown renderer's shipped TypeScript source through vite so
    // react-native can be mocked in node tests.
    server: { deps: { inline: [/react-native-markdown-display/] } },
    environment: "node",
    setupFiles: ["./packages/testkit/src/pin-test-env.ts"],
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    projects: [
      { extends: true, test: { name: "processes", include: processes } },
      { extends: true, test: { name: "isolated", include: isolated } },
      {
        extends: true,
        test: { name: "shared", include, exclude: [...processes, ...isolated], isolate: false },
      },
    ],
  },
});
