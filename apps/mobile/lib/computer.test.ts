import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { controlLabel, embeddableScreenUrl, previewPlaceholder } from "./computer.js";

describe("embeddableScreenUrl", () => {
  it("leaves a public stream URL alone", () => {
    const url = "https://sandbox.e2b.app/stream?authKey=abc&view_only=true";
    expect(embeddableScreenUrl(url, "https://api.rakazo.test")).toBe(url);
  });

  it("keeps loopback screens when the API is also loopback", () => {
    const url = "http://127.0.0.1:16080/embed.html?view_only=true";
    expect(embeddableScreenUrl(url, "http://127.0.0.1:3100")).toBe(url);
    expect(embeddableScreenUrl(url, "http://localhost:3100")).toBe(url);
  });

  it("rewrites loopback screens onto the API host for a device or emulator", () => {
    expect(
      embeddableScreenUrl(
        "http://127.0.0.1:16080/embed.html?view_only=false",
        "http://10.0.2.2:3100",
      ),
    ).toBe("http://10.0.2.2:16080/embed.html?view_only=false");
    expect(
      embeddableScreenUrl("http://localhost:16080/embed.html", "http://192.168.1.20:3100"),
    ).toBe("http://192.168.1.20:16080/embed.html");
  });

  it("returns null when there is no screen", () => {
    expect(embeddableScreenUrl(null, "http://127.0.0.1:3100")).toBeNull();
  });
});

describe("computer copy", () => {
  it("matches the web pane while booting, asleep, or in control", () => {
    expect(previewPlaceholder("stopped", false, "Chief")).toBe("Computer is stopped");
    expect(previewPlaceholder("suspended", false, "Chief")).toBe(
      "Computer is asleep — take control to wake it",
    );
    expect(previewPlaceholder("running", true, "Chief")).toBe("Booting live desktop…");
    expect(
      controlLabel(
        {
          state: "running",
          controlHolder: "user",
          controlBotId: "bot-1",
          screenAvailable: true,
          mode: "team",
          busyBotName: null,
        },
        "Chief",
        "bot-1",
      ),
    ).toBe("You have control");
    expect(
      controlLabel(
        {
          state: "running",
          controlHolder: "user",
          controlBotId: "other-bot",
          screenAvailable: true,
          mode: "team",
          busyBotName: null,
        },
        "Chief",
        "bot-1",
      ),
    ).toBe("Team Computer");
    expect(
      controlLabel(
        {
          state: "suspended",
          controlHolder: "none",
          controlBotId: null,
          screenAvailable: false,
          mode: "team",
          busyBotName: null,
        },
        "Chief",
      ),
    ).toBe("Asleep");
  });
});

describe("mobile computer screen", () => {
  it("boots, takes over, heartbeats, and releases like web", () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../app/computer.tsx"),
      "utf8",
    );
    expect(src).toContain("computer/boot");
    expect(src).toContain("computer/takeover");
    expect(src).toContain("computer/release");
    expect(src).toContain("computer/heartbeat");
    expect(src).toContain("Take control");
    expect(src).toContain("Release");
    expect(src).toContain("Close computer");
    expect(src).toContain("currentApiBase()");
  });
});
