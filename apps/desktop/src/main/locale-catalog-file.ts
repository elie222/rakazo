import { readFileSync } from "node:fs";
import path from "node:path";

/** A catalog file name is one language tag plus `.json`. Dots and slashes never match. */
const CATALOG_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

export function isDesktopCatalogTag(locale: string): boolean {
  return CATALOG_TAG.test(locale);
}

/**
 * Reads `directory/<locale>.json`. `locale` must be one of `allowed` and a language tag,
 * so the path is never built from an arbitrary string. A missing or unreadable file
 * returns `undefined` and a stderr warning. Electron main does not install a logger,
 * so `console.warn` is what shows up. Startup continues.
 */
export function readDesktopLocaleCatalog(
  directory: string,
  locale: string,
  allowed: readonly string[],
): Readonly<Record<string, string>> | undefined {
  if (!allowed.includes(locale) || !isDesktopCatalogTag(locale)) return {};
  const root = path.resolve(directory);
  const file = path.join(root, `${locale}.json`);
  if (path.dirname(file) !== root) return {};
  try {
    return messagesFromJson(readFileSync(file, "utf8"));
  } catch (error) {
    console.warn(`desktop locale catalog unavailable: ${locale}`, error);
    return undefined;
  }
}

function messagesFromJson(raw: string): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("desktop locale catalog is not an object");
  }
  const messages: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error("desktop locale catalog has a value that is not a string");
    }
    messages[key] = value;
  }
  return messages;
}
