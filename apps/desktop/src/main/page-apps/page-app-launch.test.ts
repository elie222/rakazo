import { describe, expect, it } from "vitest";
import { launchedPageAppId, launcherExecutable, pageAppArgument } from "./page-app-launch.js";

describe("launchedPageAppId", () => {
  it("reads the app a launcher started on Windows and Linux", () => {
    const argv = ["C:\\Rakazo\\Rakazo.exe", pageAppArgument("app_1-B")];
    expect(launchedPageAppId(argv, "win32")).toBe("app_1-B");
    expect(launchedPageAppId(argv, "linux")).toBe("app_1-B");
  });

  it("starts Rakazo itself on macOS and for an id that is not plain", () => {
    expect(launchedPageAppId(["Rakazo", "--page-app=app1"], "darwin")).toBeNull();
    expect(launchedPageAppId(["rakazo", "--page-app=../app1"], "linux")).toBeNull();
    expect(launchedPageAppId(["rakazo", "--page-app="], "linux")).toBeNull();
    expect(launchedPageAppId(["rakazo"], "win32")).toBeNull();
  });
});

describe("launcherExecutable", () => {
  it("runs the AppImage when there is one, otherwise Rakazo's own executable", () => {
    expect(launcherExecutable({ APPIMAGE: "/home/a/Rakazo.AppImage" }, "/tmp/.mount/rakazo")).toBe(
      "/home/a/Rakazo.AppImage",
    );
    expect(launcherExecutable({}, "/opt/rakazo/rakazo")).toBe("/opt/rakazo/rakazo");
  });
});
