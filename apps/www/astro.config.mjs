import react from "@astrojs/react";
import { satteri } from "@astrojs/markdown-satteri";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { buildChecks } from "./src/build-checks.ts";
import { docsCallouts } from "./src/docs-callouts.ts";
import { LOCALE_HREFLANG, LOCALES } from "./src/i18n/locales.ts";
import { marketing } from "./src/marketing-site.ts";
import { sitemapEntry } from "./src/sitemap.ts";
import { resolveWwwPort } from "./www-port.mjs";

const wwwPort = resolveWwwPort();

export default defineConfig({
  site: "https://rakazo.com",
  output: "static",
  i18n: {
    defaultLocale: "en",
    locales: [...LOCALES],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  integrations: [
    ...(marketing.integration ? [marketing.integration] : []),
    buildChecks(),
    react(),
    sitemap({
      filter: (page) => {
        const { pathname } = new URL(page);
        return !pathname.endsWith(".xml") && marketing.isIndexedPath(pathname);
      },
      serialize: sitemapEntry,
      i18n: {
        defaultLocale: "en",
        locales: LOCALE_HREFLANG,
      },
    }),
  ],
  markdown: {
    processor: satteri({ hastPlugins: [docsCallouts] }),
  },
  vite: {
    plugins: [tailwindcss()],
  },
  server: {
    host: "127.0.0.1",
    port: wwwPort,
    strictPort: true,
  },
  preview: {
    host: "0.0.0.0",
    port: wwwPort,
  },
});
