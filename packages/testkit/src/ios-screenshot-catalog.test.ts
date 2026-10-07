import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadIosScreenshotCatalog } from "./ios-screenshot-catalog.js";

const catalogDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../apps/mobile/e2e/ios-screenshots",
);

describe("iOS screenshot catalog", () => {
  it("lists named sections whose flow files exist", async () => {
    const sections = await loadIosScreenshotCatalog(catalogDir);
    expect(sections.map((section) => section.id)).toEqual([
      "auth",
      "onboarding",
      "inbox",
      "thread",
      "search",
      "compose",
      "settings",
    ]);
    for (const section of sections) {
      await access(path.join(catalogDir, section.flow));
    }
  });
});
