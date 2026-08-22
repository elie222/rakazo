import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSetup, readSetup, setupFilePath, writeSetup } from "./setup-store.js";

let userData: string;

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "rakazo-setup-"));
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("setup store", () => {
  it("reports no setup before the first run", async () => {
    await expect(readSetup(userData)).resolves.toBeNull();
  });

  it("keeps the chosen instance across launches", async () => {
    await writeSetup(userData, { mode: "remote", serverUrl: "https://rakazo.example.com" });
    await expect(readSetup(userData)).resolves.toEqual({
      mode: "remote",
      serverUrl: "https://rakazo.example.com",
    });
  });

  it("creates the user data directory when it does not exist yet", async () => {
    const nested = path.join(userData, "nested", "profile");
    await writeSetup(nested, { mode: "local", serverUrl: "http://127.0.0.1:5173" });
    await expect(readSetup(nested)).resolves.toEqual({
      mode: "local",
      serverUrl: "http://127.0.0.1:5173",
    });
  });

  it("falls back to setup when the saved file is corrupt", async () => {
    await writeFile(setupFilePath(userData), "{ not json", "utf8");
    await expect(readSetup(userData)).resolves.toBeNull();
  });

  it("forgets the instance after clearing", async () => {
    await writeSetup(userData, { mode: "local", serverUrl: "http://127.0.0.1:5173" });
    await clearSetup(userData);
    await expect(readSetup(userData)).resolves.toBeNull();
  });

  it("clears without complaint when nothing was saved", async () => {
    await expect(clearSetup(userData)).resolves.toBeUndefined();
  });
});
