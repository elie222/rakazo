import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isDesktopCatalogTag as emitCatalogTag } from "../../scripts/locale-catalogs.js";
import { isDesktopCatalogTag, readDesktopLocaleCatalog } from "./locale-catalog-file.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function tempLocales(): { root: string; directory: string } {
  const root = mkdtempSync(path.join(tmpdir(), "rakazo-locale-file-"));
  const directory = path.join(root, "locales");
  mkdirSync(directory);
  return { root, directory };
}

describe("desktop locale catalog file", () => {
  it("uses the same language-tag rule when the build names a catalog file", () => {
    for (const tag of ["es", "pt-BR", "zh-TW", "en-US", "../es", "es/secret", "", "e"]) {
      expect(emitCatalogTag(tag), tag).toBe(isDesktopCatalogTag(tag));
    }
    expect(isDesktopCatalogTag("pt-BR")).toBe(true);
    expect(isDesktopCatalogTag("../es")).toBe(false);
  });

  it("reads one allowlisted catalog and ignores a tag that is not on the list", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { root, directory } = tempLocales();
    try {
      writeFileSync(path.join(directory, "es.json"), JSON.stringify({ Hello: "hola" }));
      writeFileSync(path.join(directory, "fr.json"), JSON.stringify({ Hello: "bonjour" }));
      expect(readDesktopLocaleCatalog(directory, "es", ["es"])).toEqual({ Hello: "hola" });
      expect(readDesktopLocaleCatalog(directory, "fr", ["es"])).toEqual({});
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("does not build a path from a tag that leaves the catalog directory", () => {
    const { root, directory } = tempLocales();
    try {
      writeFileSync(path.join(root, "secret.json"), JSON.stringify({ Hello: "outside" }));
      writeFileSync(path.join(directory, "es.json"), JSON.stringify({ Hello: "hola" }));
      expect(readDesktopLocaleCatalog(directory, "../secret", ["../secret"])).toEqual({});
      expect(readDesktopLocaleCatalog(directory, "es/../../secret", ["es"])).toEqual({});
      expect(readDesktopLocaleCatalog(directory, "es", ["es"])).toEqual({ Hello: "hola" });
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("warns on stderr and returns no catalog when the file is missing or not a string map", () => {
    // Electron main leaves the default @rakazo/logging logger off, so the warning has to reach stderr itself.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { root, directory } = tempLocales();
    try {
      expect(readDesktopLocaleCatalog(directory, "es", ["es"])).toBeUndefined();
      for (const raw of ["{", "[]", "null", JSON.stringify({ Hello: 1 })]) {
        writeFileSync(path.join(directory, "es.json"), raw);
        expect(readDesktopLocaleCatalog(directory, "es", ["es"])).toBeUndefined();
      }
      writeFileSync(path.join(directory, "es.json"), JSON.stringify({ Hello: "hola", Bye: 2 }));
      expect(readDesktopLocaleCatalog(directory, "es", ["es"])).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true });
    }
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      "desktop locale catalog unavailable: es",
      "desktop locale catalog unavailable: es",
      "desktop locale catalog unavailable: es",
      "desktop locale catalog unavailable: es",
      "desktop locale catalog unavailable: es",
      "desktop locale catalog unavailable: es",
    ]);
    expect(warn.mock.calls.every((call) => call[1] instanceof Error)).toBe(true);
  });
});
