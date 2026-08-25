import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
    await writeSetup(userData, { mode: "existing", serverUrl: "https://rakazo.example.com" });
    await expect(readSetup(userData)).resolves.toEqual({
      mode: "existing",
      serverUrl: "https://rakazo.example.com",
    });
  });

  it("clears saved setup so first-run runs again", async () => {
    await writeSetup(userData, { mode: "existing", serverUrl: "https://rakazo.example.com" });
    await clearSetup(userData);
    await expect(readSetup(userData)).resolves.toBeNull();
  });

  it("creates the user data directory when it does not exist yet", async () => {
    const nested = path.join(userData, "nested", "profile");
    await writeSetup(nested, { mode: "new", serverUrl: "http://127.0.0.1:5173" });
    await expect(readSetup(nested)).resolves.toEqual({
      mode: "new",
      serverUrl: "http://127.0.0.1:5173",
    });
  });

  it.runIf(process.platform !== "win32")("keeps the saved address private", async () => {
    await writeSetup(userData, { mode: "existing", serverUrl: "https://rakazo.example.com" });
    const info = await stat(setupFilePath(userData));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== "win32")(
    "replaces a final symlink instead of overwriting its target",
    async () => {
      const victim = path.join(userData, "victim.txt");
      await writeFile(victim, "untouched", "utf8");
      await symlink(victim, setupFilePath(userData));

      await writeSetup(userData, { mode: "existing", serverUrl: "https://rakazo.example.com" });

      await expect(readSetup(userData)).resolves.toEqual({
        mode: "existing",
        serverUrl: "https://rakazo.example.com",
      });
      await expect(readFile(victim, "utf8")).resolves.toBe("untouched");
    },
  );

  it("falls back to setup when the saved file is corrupt", async () => {
    await writeFile(setupFilePath(userData), "{ not json", "utf8");
    await expect(readSetup(userData)).resolves.toBeNull();
  });
});
