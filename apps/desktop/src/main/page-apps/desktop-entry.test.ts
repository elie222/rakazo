import { describe, expect, it } from "vitest";
import { applicationsDir, desktopEntry } from "./desktop-entry.js";

describe("desktopEntry", () => {
  it("starts the app through Rakazo and groups its windows under the entry", () => {
    expect(
      desktopEntry({
        appId: "app1",
        name: "Deal Tracker",
        executable: "/home/a/Apps/Rakazo.AppImage",
        icon: "/home/a/.config/Rakazo Apps/app1/icon.png",
      }),
    ).toBe(
      [
        "[Desktop Entry]",
        "Type=Application",
        "Version=1.5",
        "Name=Deal Tracker",
        'Exec="/home/a/Apps/Rakazo.AppImage" "--page-app=app1"',
        "Icon=/home/a/.config/Rakazo Apps/app1/icon.png",
        "StartupWMClass=rakazo-page-app-app1",
        "Categories=Utility;",
        "Terminal=false",
        "",
      ].join("\n"),
    );
  });

  it("quotes an executable path with characters the spec reserves", () => {
    const entry = desktopEntry({
      appId: "app1",
      name: " Odd\\name",
      executable: '/home/a/my "apps"/$HOME/100%/back\\slash/rakazo',
      icon: "/icon.png",
    });
    expect(entry).toContain("Name=\\sOdd\\\\name\n");
    expect(entry).toContain(
      'Exec="/home/a/my \\\\"apps\\\\"/\\\\$HOME/100%%/back\\\\\\\\slash/rakazo" "--page-app=app1"\n',
    );
  });
});

describe("applicationsDir", () => {
  it("follows XDG_DATA_HOME and falls back to the user's local share folder", () => {
    expect(applicationsDir({ XDG_DATA_HOME: "/data" }, "/home/a")).toBe("/data/applications");
    expect(applicationsDir({}, "/home/a")).toBe("/home/a/.local/share/applications");
  });
});
