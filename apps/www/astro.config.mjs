import react from "@astrojs/react";
import { satteri } from "@astrojs/markdown-satteri";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { existsSync } from "node:fs";
import { defineConfig } from "astro/config";
import { isIndexedPath } from "./src/blog/indexability.ts";
import { docsCallouts } from "./src/docs-callouts.ts";
import { LOCALE_HREFLANG, LOCALES } from "./src/i18n/locales.ts";
import { ogPages, ogPublicPath } from "./src/og-pages.ts";
import { resolveWwwPort } from "./www-port.mjs";

const wwwPort = resolveWwwPort();

/** Fails the build when a page, every blog post included, has no rendered Open Graph image. */
const ogImages = {
  name: "og-images",
  hooks: {
    "astro:config:done": ({ config }) => {
      const missing = ogPages()
        .map((page) => ogPublicPath(page.id))
        .filter((path) => !existsSync(new URL(`.${path}`, config.publicDir)));
      if (missing.length > 0) {
        throw new Error(
          `Missing Open Graph images: ${missing.join(", ")}. Render them with scripts/render-og.mjs.`,
        );
      }
    },
  },
};

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
    ogImages,
    react(),
    sitemap({
      filter: (page) => isIndexedPath(new URL(page).pathname),
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
