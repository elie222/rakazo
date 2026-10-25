import { transformAsync } from "@babel/core";
import { getConfig } from "@lingui/conf";
import { lingui } from "@lingui/vite-plugin";
import type { PluginOption } from "vite";

/** Exercise real markdown macros and catalogs while retaining other tests' macro mocks. */
export function markdownLinguiTestPlugins(): PluginOption[] {
  const configPath = new URL("./lingui.config.ts", import.meta.url).pathname;
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
          parserOpts: { plugins: ["typescript", "jsx"] },
          plugins: [["@lingui/babel-plugin-lingui-macro", { linguiConfig }]],
        });
        return result?.code;
      },
    },
    lingui({ configPath }),
  ];
}
