import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transformAsync } from "@babel/core";
import { getConfig } from "@lingui/conf";
import { lingui } from "@lingui/vite-plugin";
import type { PluginOption } from "vite";

/** Exercise real markdown macros and catalogs while retaining other tests' macro mocks. */
export function markdownLinguiTestPlugins(): PluginOption[] {
  const configPath = fileURLToPath(new URL("./lingui.config.ts", import.meta.url));
  const linguiMacroPluginPath = createRequire(import.meta.url).resolve(
    "@lingui/babel-plugin-lingui-macro",
  );
  const linguiConfig = getConfig({ configPath });
  return [
    {
      name: "markdown-lingui-test-macros",
      enforce: "pre",
      async transform(code, id) {
        if (!id.endsWith("/apps/web/src/components/markdown-copy.tsx")) return;
        const result = await transformAsync(code, {
          filename: id,
          configFile: false,
          babelrc: false,
          cwd: dirname(configPath),
          parserOpts: { plugins: ["typescript", "jsx"] },
          plugins: [[linguiMacroPluginPath, { linguiConfig }]],
        });
        return result?.code;
      },
    },
    lingui({ configPath }),
  ];
}
