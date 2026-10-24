import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { redirectSystemPath } from "../app/+native-intent";
import {
  closeSettingsSheet,
  isSettingsLink,
  registerSettingsSheet,
  settingsSheetCloser,
} from "./settings-sheet";

vi.mock("./incoming-share", () => ({ receiveIncomingShare: vi.fn() }));

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("settings sheet", () => {
  it("does nothing while no sheet is open", () => {
    expect(() => closeSettingsSheet()).not.toThrow();
  });

  it("closes the open sheet, and stops once it unregisters", () => {
    const close = vi.fn();
    const unregister = registerSettingsSheet(close);
    closeSettingsSheet();
    unregister();
    closeSettingsSheet();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer sheet registered when an older one unregisters late", () => {
    const older = vi.fn();
    const newer = vi.fn();
    const unregisterOlder = registerSettingsSheet(older);
    const unregisterNewer = registerSettingsSheet(newer);
    unregisterOlder();
    closeSettingsSheet();
    unregisterNewer();

    expect(older).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledTimes(1);
  });

  it("goes back to the screen under the sheet", () => {
    const sheet = { canGoBack: () => true, goBack: vi.fn(), dispatch: vi.fn() };
    settingsSheetCloser(sheet)();

    expect(sheet.goBack).toHaveBeenCalledTimes(1);
    expect(sheet.dispatch).not.toHaveBeenCalled();
  });

  it("gives way to Home as the app's first screen", () => {
    const sheet = { canGoBack: () => false, goBack: vi.fn(), dispatch: vi.fn() };
    settingsSheetCloser(sheet)();

    expect(sheet.goBack).not.toHaveBeenCalled();
    expect(sheet.dispatch).toHaveBeenCalledWith({ type: "REPLACE", payload: { name: "index" } });
  });
});

describe("settings links", () => {
  it.each([true, false])("opens the share target for cold/warm arrivals (%s)", (initial) => {
    expect(redirectSystemPath({ path: "rakazo://expo-sharing", initial })).toBe("/share");
  });
  it("knows every public page in the settings group", () => {
    const pages = readdirSync(resolve(mobileRoot, "app/(settings)"))
      .filter((file) => file !== "_layout.tsx" && file !== "model-picker.tsx")
      .map((file) => file.replace(/\.tsx$/, ""));

    for (const page of pages) expect(isSettingsLink(`/${page}`), page).toBe(true);
  });

  it("reads the page from any link form", () => {
    expect(isSettingsLink("rakazo:///models")).toBe(true);
    // Picker sessions only exist after an in-sheet push, never from a link.
    expect(isSettingsLink("rakazo:///model-picker")).toBe(false);
    expect(isSettingsLink("rakazo://voice")).toBe(true);
    expect(isSettingsLink("rakazo:///account?focus=usage")).toBe(true);
    expect(isSettingsLink("rakazo://integrations/")).toBe(true);
    expect(isSettingsLink("/change-password")).toBe(true);
    expect(isSettingsLink("rakazo:///thread?botId=bot-1")).toBe(false);
    expect(isSettingsLink("rakazo://group-thread?groupId=group-1")).toBe(false);
    expect(isSettingsLink("/new")).toBe(false);
    expect(isSettingsLink("/artifacts")).toBe(false);
    expect(isSettingsLink("rakazo:///artifacts")).toBe(false);
    expect(isSettingsLink("rakazo://")).toBe(false);
    expect(isSettingsLink("rakazo:///accounts")).toBe(false);
  });

  it("closes the sheet before a link to another screen, and keeps settings links in it", () => {
    const close = vi.fn();
    const unregister = registerSettingsSheet(close);

    expect(redirectSystemPath({ path: "rakazo:///voice", initial: false })).toBe("rakazo:///voice");
    expect(redirectSystemPath({ path: "rakazo:///account?focus=usage", initial: false })).toBe(
      "rakazo:///account?focus=usage",
    );
    expect(close).not.toHaveBeenCalled();

    expect(redirectSystemPath({ path: "rakazo:///thread?botId=bot-1", initial: false })).toBe(
      "rakazo:///thread?botId=bot-1",
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(redirectSystemPath({ path: "rakazo://expo-sharing", initial: true })).toBe("/share");
    expect(close).toHaveBeenCalledTimes(2);
    expect(redirectSystemPath({ path: "rakazo:///artifacts", initial: false })).toBe(
      "rakazo:///artifacts",
    );
    expect(close).toHaveBeenCalledTimes(3);
    unregister();
  });
});
