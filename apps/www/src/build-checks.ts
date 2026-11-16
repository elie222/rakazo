import { existsSync, readFileSync } from "node:fs";
import type { AstroIntegration } from "astro";
import { DEFAULT_LOCALE, isLocale } from "./i18n/locales";
import { localizedPath, TRANSLATED_PAGES } from "./i18n/translations";
import { SITE_URL } from "./site";

const OG_IMAGE = /<meta property="og:image" content="([^"]+)"/;

/** Built pages whose Open Graph image is missing from the build, e.g. a blog post with no rendered card. */
function missingOgImages(pathnames: string[], dir: URL): string[] {
  return pathnames.flatMap((pathname) => {
    const html = new URL(`./${pathname}index.html`, dir);
    if (!existsSync(html)) return [];
    const image = OG_IMAGE.exec(readFileSync(html, "utf8"))?.[1];
    if (!image) return [];
    const url = new URL(image, SITE_URL);
    if (url.origin !== new URL(SITE_URL).origin) return [];
    return existsSync(new URL(`.${url.pathname}`, dir)) ? [] : [`/${pathname} → ${url.pathname}`];
  });
}

/** Registered pages (English or translated) that were not built, and localized pages that are not registered. */
function translationMismatches(pathnames: string[]): string[] {
  const built = new Set(pathnames.map((pathname) => `/${pathname}`));
  const registered = new Set(
    Object.entries(TRANSLATED_PAGES).flatMap(([path, locales]) => [
      path,
      ...locales.map((locale) => localizedPath(path, locale)),
    ]),
  );
  const unbuilt = [...registered].filter((path) => !built.has(path));
  const unregistered = [...built].filter((path) => {
    const first = path.split("/")[1];
    return (
      first !== DEFAULT_LOCALE && isLocale(first) && path.endsWith("/") && !registered.has(path)
    );
  });
  return [
    ...unbuilt.map((path) => `${path} is in TRANSLATED_PAGES but was not built`),
    ...unregistered.map((path) => `${path} was built but is missing from TRANSLATED_PAGES`),
  ];
}

/** Fails the build on a missing Open Graph image or a translation the registry does not match. */
export function buildChecks(): AstroIntegration {
  return {
    name: "build-checks",
    hooks: {
      "astro:build:done": ({ dir, pages }) => {
        const pathnames = pages.map((page) => page.pathname);
        const problems = [
          ...missingOgImages(pathnames, dir).map(
            (page) => `Missing Open Graph image for ${page}. Render it with scripts/render-og.mjs.`,
          ),
          ...translationMismatches(pathnames),
        ];
        if (problems.length > 0) throw new Error(problems.join("\n"));
      },
    },
  };
}
