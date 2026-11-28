import { readFileSync } from "node:fs";
import type { DesktopCatalogTag, DesktopMessages } from "./locale-catalogs.js";

const catalogs = new Map<DesktopCatalogTag, DesktopMessages | undefined>();

export function loadDesktopCatalog(locale: DesktopCatalogTag): DesktopMessages | undefined {
  if (catalogs.has(locale)) return catalogs.get(locale);

  let messages: DesktopMessages | undefined;
  try {
    // The locale comes from the bundled list. Electron's fs also reads files inside the ASAR.
    const file = new URL(`./locales/${locale}.json`, import.meta.url);
    const catalog: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isMessageCatalog(catalog)) throw new Error("Expected a desktop translation catalog");
    messages = catalog;
  } catch (error) {
    console.warn(`Desktop locale catalog unavailable: ${locale}`, error);
  }
  catalogs.set(locale, messages);
  return messages;
}

function isMessageCatalog(catalog: unknown): catalog is DesktopMessages {
  return (
    catalog !== null &&
    typeof catalog === "object" &&
    !Array.isArray(catalog) &&
    Object.values(catalog).every((message) => typeof message === "string")
  );
}
