import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { resolveWwwPort } from "./www-port.mjs";

const wwwPort = resolveWwwPort();

export default defineConfig({
  site: "https://rakazo.com",
  output: "static",
  i18n: {
    defaultLocale: "en",
    locales: ["en", "de", "ko", "zh"],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  integrations: [
    react(),
    sitemap({
      i18n: {
        defaultLocale: "en",
        locales: {
          en: "en-US",
          de: "de-DE",
          ko: "ko-KR",
          zh: "zh-CN",
        },
      },
    }),
  ],
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
