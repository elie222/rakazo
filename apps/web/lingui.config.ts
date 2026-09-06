import { defineConfig } from "@lingui/conf";

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es"],
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["src"],
      exclude: ["**/locales/**", "**/*.test.*"],
    },
  ],
  format: "po",
  compileNamespace: "es",
});
