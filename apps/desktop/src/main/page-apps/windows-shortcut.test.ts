import { describe, expect, it } from "vitest";
import { pageAppShortcut, windowsFileName } from "./windows-shortcut.js";

describe("pageAppShortcut", () => {
  it("starts Rakazo as the app under the app's own identity and icon", () => {
    expect(
      pageAppShortcut({
        executable: "C:\\Programs\\rakazo\\Rakazo.exe",
        appId: "App_1",
        icon: "C:\\Data\\Rakazo Apps\\App_1\\icon.ico",
        title: "Deal Tracker",
      }),
    ).toEqual({
      target: "C:\\Programs\\rakazo\\Rakazo.exe",
      args: "--page-app=App_1",
      appUserModelId: "dev.rakazo.page-app.app-1",
      icon: "C:\\Data\\Rakazo Apps\\App_1\\icon.ico",
      iconIndex: 0,
      description: "Deal Tracker",
    });
  });
});

describe("windowsFileName", () => {
  it("replaces what Windows refuses in file names", () => {
    expect(windowsFileName('Q3 <deals> "now"? *|')).toBe("Q3 -deals- -now-- --");
    expect(windowsFileName("Notes...")).toBe("Notes");
    expect(windowsFileName("con")).toBe("con_");
    expect(windowsFileName("...")).toBe("Page");
  });
});
