import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  type ComputerStatus,
  controlLabel,
  embeddableScreenUrl,
  previewPlaceholder,
  readScreenUrl,
} from "./computer.js";

function computer(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "fake",
    state: "running",
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: true,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    updateAvailable: true,
    ...overrides,
  };
}

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
      "Computer is asleep. Take control to wake it.",
    );
    expect(previewPlaceholder("running", true, "Chief")).toBe("Booting live desktop…");
    expect(
      controlLabel(
        computer({
          state: "running",
          controlHolder: "user",
          controlBotId: "bot-1",
          takeoverRequested: true,
        }),
        "Chief",
        "bot-1",
      ),
    ).toBe("You have control");
    expect(
      controlLabel(
        computer({
          state: "running",
          controlHolder: "user",
          controlBotId: "other-bot",
        }),
        "Chief",
        "bot-1",
      ),
    ).toBe("Team Computer");
    expect(
      controlLabel(
        computer({
          state: "suspended",
          controlHolder: "none",
          controlBotId: null,
          screenAvailable: false,
        }),
        "Chief",
      ),
    ).toBe("Asleep");
  });
});

describe("readScreenUrl", () => {
  it("returns the first URL without retrying", async () => {
    const request = vi.fn().mockResolvedValue({ url: "https://screen.example/embed" });
    await expect(readScreenUrl(request)).resolves.toBe("https://screen.example/embed");
    expect(request).toHaveBeenCalledOnce();
  });

  it("retries thrown RPC failures until a URL arrives", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("rpc computer/screenUrl failed"))
      .mockResolvedValue({ url: "https://screen.example/embed" });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(readScreenUrl(request, { attempts: 3, delayMs: 25, sleep })).resolves.toBe(
      "https://screen.example/embed",
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("retries empty URLs until the screen is ready", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ url: null })
      .mockResolvedValueOnce({ url: "https://screen.example/embed" });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(readScreenUrl(request, { attempts: 3, sleep })).resolves.toBe(
      "https://screen.example/embed",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rethrows the last RPC failure after the retry budget", async () => {
    const error = new Error("rpc computer/screenUrl failed");
    const request = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(readScreenUrl(request, { attempts: 3, sleep })).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns null when every attempt succeeds without a URL", async () => {
    const request = vi.fn().mockResolvedValue({ url: null });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(readScreenUrl(request, { attempts: 2, sleep })).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
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
    expect(src).toContain("SafeAreaProvider");
    expect(src).toContain("readScreenUrl");
    expect(src).toContain("SCREEN_URL_OPEN_ATTEMPTS");
  });
});
