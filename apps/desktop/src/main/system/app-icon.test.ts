import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { APP_ICONS } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appIconFile, createAppIconSetHandler, currentAppIcon, loadAppIcon } from "./app-icon.js";

let userData: string;

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "rakazo-app-icon-"));
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("app icon", () => {
  it("keeps the picked icon across launches", async () => {
    const apply = vi.fn();
    await expect(createAppIconSetHandler(userData, apply, vi.fn())(null, "cap")).resolves.toBe(
      true,
    );
    expect(apply).toHaveBeenCalledWith("cap");
    await expect(loadAppIcon(userData)).resolves.toBe("cap");
    expect(currentAppIcon()).toBe("cap");
  });

  it("refuses an icon the app does not ship", async () => {
    const apply = vi.fn();
    await expect(createAppIconSetHandler(userData, apply, vi.fn())(null, "../icon")).resolves.toBe(
      false,
    );
    expect(apply).not.toHaveBeenCalled();
    await expect(loadAppIcon(userData)).resolves.toBe("default");
  });

  it("keeps the last saved icon when the new one cannot be shown", async () => {
    await createAppIconSetHandler(userData, vi.fn(), vi.fn())(null, "cap");
    const report = vi.fn();
    const apply = vi.fn(() => {
      throw new Error("bad icon file");
    });
    await expect(createAppIconSetHandler(userData, apply, report)(null, "tie")).resolves.toBe(
      false,
    );
    expect(report).toHaveBeenCalled();
    await expect(loadAppIcon(userData)).resolves.toBe("cap");
  });

  it("bundles every icon for each platform", () => {
    const dir = path.join(import.meta.dirname, "../../../assets/app-icons");
    for (const icon of APP_ICONS) {
      for (const platform of ["darwin", "win32"] as const) {
        expect(existsSync(appIconFile(dir, icon, platform)), `${icon} on ${platform}`).toBe(true);
      }
    }
  });
});
