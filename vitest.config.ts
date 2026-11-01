import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const include = [
  ".agents/skills/pr-watch/*.test.ts",
  "packages/*/src/**/*.test.{ts,tsx}",
  "infra/sandboxes/supervisor/src/**/*.test.ts",
  "infra/updater/src/**/*.test.ts",
  "apps/desktop/src/**/*.test.ts",
  "apps/web/src/**/*.test.{ts,tsx}",
  "apps/mobile/lib/**/*.test.{ts,tsx}",
  "apps/mobile/plugins/**/*.test.js",
  "apps/api/src/**/*.test.ts",
  "apps/worker/src/**/*.test.ts",
];

// Files that mock modules, stub globals, or change the environment keep a fresh module graph;
// the rest share one per worker, which skips re-importing the same modules for every file.
// Database runs give every file its own database, so they never share.
const mutatesSharedState =
  /vi\.(mock|doMock|stubGlobal|stubEnv|resetModules|useFakeTimers|spyOn)\(|globalThis\.\w+ *=[^=]|(globalThis|global|window)\[[^\]]+\] *=[^=]|process\.env(\.\w+|\[[^\]]+\]) *=[^=]|delete process\.env|defineProperty\((globalThis|global|window|document|navigator|process)|process\.chdir|@vitest-environment/;
const isolated = include
  .flatMap((pattern) => globSync(pattern))
  .filter(
    (file) => process.env.COPY_TEST_DATABASE || mutatesSharedState.test(readFileSync(file, "utf8")),
  );

export default defineConfig({
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
    testTimeout: 30_000,
    hookTimeout: 60_000,
    projects: [
      { extends: true, test: { name: "isolated", include: isolated } },
      { extends: true, test: { name: "shared", include, exclude: isolated, isolate: false } },
    ],
  },
});
