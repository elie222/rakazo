import { afterEach, describe, expect, it, vi } from "vitest";

const application = vi.hoisted(() => ({
  nativeApplicationVersion: null as string | null,
  nativeBuildVersion: null as string | null,
}));

const updates = vi.hoisted(() => ({
  isEnabled: false,
  isEmbeddedLaunch: true,
  updateId: null as string | null,
  channel: null as string | null,
  createdAt: null as Date | null,
}));

const constants = vi.hoisted(() => ({
  expoConfig: { version: "1.0.3" } as { version?: string } | null,
  platform: {
    ios: { buildNumber: "1" },
    android: { versionCode: 10 },
  } as {
    ios?: { buildNumber: string | null };
    android?: { versionCode: number };
  },
}));

vi.mock("expo-application", () => application);
vi.mock("expo-updates", () => updates);
vi.mock("expo-constants", () => ({ default: constants }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

afterEach(() => {
  application.nativeApplicationVersion = null;
  application.nativeBuildVersion = null;
  updates.isEnabled = false;
  updates.isEmbeddedLaunch = true;
  updates.updateId = null;
  updates.channel = null;
  updates.createdAt = null;
  constants.expoConfig = { version: "1.0.3" };
  constants.platform = {
    ios: { buildNumber: "1" },
    android: { versionCode: 10 },
  };
  vi.resetModules();
});

describe("app version footer helpers", () => {
  it("formats native version with and without build", async () => {
    const { formatNativeVersionLabel, shortUpdateId } = await import("./app-version");
    expect(formatNativeVersionLabel("1.0.3", "10")).toBe("1.0.3 (10)");
    expect(formatNativeVersionLabel("1.0.3", null)).toBe("1.0.3");
    expect(formatNativeVersionLabel(null, "10")).toBe("10");
    expect(formatNativeVersionLabel("  ", "  ")).toBeNull();
    expect(shortUpdateId("A1B2C3D4-E5F6-7890-ABCD-EF1234567890")).toBe("a1b2c3d4");
  });

  it("prefers expo-application values and labels embedded updates", async () => {
    application.nativeApplicationVersion = "1.0.3";
    application.nativeBuildVersion = "12";
    updates.isEnabled = true;
    updates.isEmbeddedLaunch = true;
    const { formatUpdateLabel, getAppVersionInfo } = await import("./app-version");
    const info = getAppVersionInfo();
    expect(info.nativeLabel).toBe("1.0.3 (12)");
    expect(info.update).toEqual({ kind: "embedded" });
    expect(formatUpdateLabel(info.update, (message) => message)).toBe("Embedded");
  });

  it("falls back to Constants when Application is empty", async () => {
    const { getAppVersionInfo } = await import("./app-version");
    expect(getAppVersionInfo().nativeLabel).toBe("1.0.3 (1)");
  });

  it("summarizes an OTA update with channel and date", async () => {
    application.nativeApplicationVersion = "1.0.3";
    application.nativeBuildVersion = "12";
    updates.isEnabled = true;
    updates.isEmbeddedLaunch = false;
    updates.updateId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    updates.channel = "production";
    updates.createdAt = new Date("2026-09-10T12:00:00.000Z");
    const { formatUpdateLabel, getAppVersionInfo } = await import("./app-version");
    const info = getAppVersionInfo();
    expect(info.update).toEqual({
      kind: "ota",
      id: "a1b2c3d4",
      channel: "production",
      createdAt: "2026-09-10",
    });
    expect(
      formatUpdateLabel(info.update, (message, values) => {
        if (!values) return message;
        return message.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
          Object.hasOwn(values, key) ? String(values[key]) : match,
        );
      }),
    ).toBe("production · a1b2c3d4 · 2026-09-10");
  });

  it("treats disabled updates as embedded", async () => {
    updates.isEnabled = false;
    updates.isEmbeddedLaunch = false;
    updates.updateId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const { getAppVersionInfo } = await import("./app-version");
    expect(getAppVersionInfo().update).toEqual({ kind: "embedded" });
  });
});
