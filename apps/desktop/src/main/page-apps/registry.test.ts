import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstalledPageApp } from "./registry.js";
import { createRegistry, readRegistry } from "./registry.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "rakazo-page-apps-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const app = (appId: string): InstalledPageApp => ({
  appId,
  pageId: "page1",
  title: "Deals",
  server: "https://rakazo.example.com",
  bundlePath: `/Applications/Rakazo Apps/${appId}.app`,
});

describe("page app registry", () => {
  it("keeps both of two installs that finish together, and removes by id", async () => {
    const registry = createRegistry(dir);
    await Promise.all([registry.put(app("a")), registry.put(app("b"))]);
    expect((await registry.list()).map((entry) => entry.appId).sort()).toEqual(["a", "b"]);
    await registry.remove("a");
    expect((await registry.list()).map((entry) => entry.appId)).toEqual(["b"]);
  });

  it("leaves out entries it cannot use and reads a broken file as empty", async () => {
    const file = path.join(dir, "page-apps.json");
    await writeFile(
      file,
      JSON.stringify({
        apps: [app("ok"), { ...app("../escape") }, { ...app("x"), bundlePath: "relative" }],
      }),
    );
    expect((await readRegistry(dir)).map((entry) => entry.appId)).toEqual(["ok"]);
    await writeFile(file, "{");
    expect(await readRegistry(dir)).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("{");
  });
});
