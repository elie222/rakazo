import { describe, expect, it, vi } from "vitest";
import type { ComputerStatus } from "./computer.js";
import {
  controlLabel,
  embeddableScreenUrl,
  fromScreenPage,
  isProxiedScreenPage,
  nextLoadedScreenUrl,
  previewPlaceholder,
  readScreenUrl,
  retainScreenSource,
  SCREEN_URL_RENEW_MS,
  screenPageState,
  screenPageStatus,
  screenRenewReadAt,
  screenStreamKey,
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
    canUpdate: true,
    terminalAvailable: true,
    ...overrides,
  };
}

describe("embeddableScreenUrl", () => {
  it("leaves a public stream URL alone", () => {
    const url = "https://sandbox.e2b.app/stream?authKey=abc&view_only=true";
    expect(embeddableScreenUrl(url, "https://api.rakazo.test")).toBe(url);
  });

  it.each(["screen.example", "8.8.8.8", "172.32.0.1", "100.63.255.255", "100.128.0.1"])(
    "rejects public HTTP screens on %s",
    (host) => {
      expect(embeddableScreenUrl(`http://${host}/embed.html`, "https://api.example")).toBeNull();
    },
  );

  it.each([
    "localhost",
    "127.0.0.1",
    "[::1]",
    "server.local",
    "10.0.2.2",
    "192.168.1.20",
    "172.16.0.1",
    "172.31.255.255",
    "100.64.0.1",
    "100.127.255.255",
  ])("keeps LAN and local HTTP screens on %s", (host) => {
    const url = `http://${host}:16080/embed.html`;
    expect(embeddableScreenUrl(url, "http://localhost:3100")).toBe(url);
  });

  it("rejects loopback HTTP screens rewritten to a public API host", () => {
    expect(
      embeddableScreenUrl("http://localhost:16080/embed.html", "https://api.example"),
    ).toBeNull();
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

  it("does not send unsupported fixture URLs to the native WebView", () => {
    expect(
      embeddableScreenUrl("fake://screen/fake-team-home/researcher", "http://10.0.2.2:3100"),
    ).toBeNull();
    expect(embeddableScreenUrl("not a URL", "http://10.0.2.2:3100")).toBeNull();
  });
});

describe("screen stream identity", () => {
  const now = 1_710_000_000_000;
  const view = (token: string, expiresAt = now + 60 * 60_000) =>
    `https://app.example/novnc/session/view/${expiresAt}.${token}/embed.html?autoconnect=true&resize=scale&view_only=true&path=websockify`;
  const control = (token: string, expiresAt = now + 60 * 60_000) =>
    `https://app.example/novnc/session/control/${expiresAt}.${token}/embed.html?autoconnect=true&resize=scale&view_only=false&path=websockify`;

  it("treats rotating capability tokens as the same running view stream", () => {
    expect(screenStreamKey(view("aaaToken"))).toBe(screenStreamKey(view("bbbToken")));
    expect(retainScreenSource(view("aaaToken"), view("bbbToken"), now)).toBe(view("aaaToken"));
  });

  it("adopts a same-stream URL once the held capability is in the renew window", () => {
    const held = view("oldToken", now + 10 * 60_000);
    const renewed = view("newToken", now + 60 * 60_000);
    expect(screenStreamKey(held)).toBe(screenStreamKey(renewed));
    expect(retainScreenSource(held, renewed, now)).toBe(renewed);
    expect(retainScreenSource(view("oldToken"), view("newToken", now + 65 * 60_000), now)).toBe(
      view("oldToken"),
    );
  });

  it("reconnects when view vs control changes or the computer origin changes", () => {
    expect(screenStreamKey(view("aaaToken"))).not.toBe(screenStreamKey(control("aaaToken")));
    expect(retainScreenSource(view("aaaToken"), control("cccToken"), now)).toBe(
      control("cccToken"),
    );
    expect(
      retainScreenSource(
        view("aaaToken"),
        "https://other.example/novnc/session/view/1710000000000.aaaToken/embed.html",
        now,
      ),
    ).toBe("https://other.example/novnc/session/view/1710000000000.aaaToken/embed.html");
  });

  it("keeps a visible screen on the loaded URL when the capability refreshes early", () => {
    const held = view("aaaToken");
    const refreshed = view("bbbToken");
    expect(nextLoadedScreenUrl(held, refreshed, true, now)).toBe(held);
    expect(nextLoadedScreenUrl(held, refreshed, false, now)).toBeNull();
    expect(nextLoadedScreenUrl(null, refreshed, true, now)).toBe(refreshed);
    expect(nextLoadedScreenUrl(held, control("cccToken"), true, now)).toBe(control("cccToken"));
    const renewing = view("oldToken", now + 10 * 60_000);
    expect(nextLoadedScreenUrl(renewing, view("newToken", now + 70 * 60_000), true, now)).toBe(
      view("newToken", now + 70 * 60_000),
    );
  });

  it("renews a reused seal before its original expiry", () => {
    const issuedAt = now;
    const readAt = issuedAt + 20 * 60_000;
    const expiresAt = issuedAt + 60 * 60_000;
    const reused = view("reused", expiresAt);
    const renewAt = screenRenewReadAt(reused, readAt) + SCREEN_URL_RENEW_MS;
    expect(screenRenewReadAt(reused, readAt)).toBe(issuedAt);
    expect(renewAt).toBe(expiresAt - 10 * 60_000);
    expect(renewAt).toBeLessThan(expiresAt);
    expect(readAt + SCREEN_URL_RENEW_MS).toBeGreaterThan(expiresAt);
    const fresh = view("fresh", readAt + 60 * 60_000);
    expect(screenRenewReadAt(fresh, readAt)).toBe(readAt);
    expect(screenRenewReadAt("https://sandbox.example/stream?authKey=one", readAt)).toBe(readAt);
    expect(screenRenewReadAt(null, readAt)).toBe(readAt);
  });

  it("keeps view vs control for provider URLs whose query token rotates", () => {
    const held = "https://sandbox.example/stream?authKey=one&view_only=true";
    const rotated = "https://sandbox.example/stream?authKey=two&view_only=true";
    const takeover = "https://sandbox.example/stream?authKey=two&view_only=false";
    expect(screenStreamKey(held)).toBe(screenStreamKey(rotated));
    expect(retainScreenSource(held, rotated, now)).toBe(held);
    expect(retainScreenSource(held, takeover, now)).toBe(takeover);
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

  it("stops at a refused read but retries through a 503", async () => {
    const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
    const refused = httpError(403);
    const request = vi.fn().mockRejectedValueOnce(httpError(503)).mockRejectedValue(refused);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(readScreenUrl(request, { attempts: 5, sleep })).rejects.toBe(refused);
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("returns null when every attempt succeeds without a URL", async () => {
    const request = vi.fn().mockResolvedValue({ url: null });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(readScreenUrl(request, { attempts: 2, sleep })).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("screen page states", () => {
  it("takes only the exact state message a screen page posts", () => {
    expect(screenPageState('{"rakazoScreen":"connected"}')).toBe("connected");
    expect(screenPageState('{"rakazoScreen":"disconnected"}')).toBe("disconnected");
    expect(screenPageState('{"rakazoScreen":"connected","detail":"text"}')).toBeNull();
    expect(screenPageState('{"rakazoScreen":"reconnect"}')).toBeNull();
    expect(screenPageState('["connected"]')).toBeNull();
    expect(screenPageState('"connected"')).toBeNull();
    expect(screenPageState("null")).toBeNull();
    expect(screenPageState("not json")).toBeNull();
  });
});

describe("screen page status", () => {
  it("reads only the status of the screen page", async () => {
    const cancel = vi.fn(async () => undefined);
    const text = vi.fn(async () => "Invalid or expired screen capability");
    const fetchImpl = vi.fn(
      async () => ({ status: 503, body: { cancel }, text }) as unknown as Response,
    );
    await expect(screenPageStatus("https://app.example.test/novnc/x", fetchImpl)).resolves.toBe(
      503,
    );
    expect(text).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith("https://app.example.test/novnc/x", {
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
    });
    await expect(
      screenPageStatus("https://app.example.test/novnc/x", async () => {
        throw new TypeError("Network request failed");
      }),
    ).resolves.toBeNull();
  });
});

describe("screen page redirects and origin", () => {
  it("counts an answer from anywhere but the probe as no page, as React Native follows redirects", async () => {
    // React Native ignores `redirect: "manual"`, follows the redirect and leaves `redirected`
    // unset; only the final URL tells.
    const followed = vi.fn(
      async () =>
        ({
          status: 200,
          url: "https://api.example.test/elsewhere",
          type: "default",
        }) as unknown as Response,
    );
    await expect(
      screenPageStatus("https://app.example.test/novnc/x?rakazo_probe=1", followed),
    ).resolves.toBe(0);
    const same = vi.fn(
      async () =>
        ({
          status: 204,
          url: "https://app.example.test/novnc/x?rakazo_probe=1",
          type: "default",
        }) as unknown as Response,
    );
    await expect(
      screenPageStatus("https://app.example.test/novnc/x?rakazo_probe=1", same),
    ).resolves.toBe(204);
    const redirected = vi.fn(
      async () => ({ status: 200, redirected: true, type: "basic" }) as unknown as Response,
    );
    await expect(screenPageStatus("https://app.example.test/novnc/x", redirected)).resolves.toBe(0);
    const manual = vi.fn(
      async () => ({ status: 0, redirected: false, type: "opaqueredirect" }) as unknown as Response,
    );
    await expect(screenPageStatus("https://app.example.test/novnc/x", manual)).resolves.toBe(0);
  });

  it("hears only the screen's own origin", () => {
    const screen = "https://app.example.test/novnc/session/control/1.t/vnc.html";
    expect(
      fromScreenPage("https://app.example.test/novnc/session/control/1.t/vnc.html", screen),
    ).toBe(true);
    expect(fromScreenPage("https://elsewhere.example.test/", screen)).toBe(false);
    expect(fromScreenPage(undefined, screen)).toBe(false);
    expect(fromScreenPage("not a url", screen)).toBe(false);
  });

  it("keeps one stream key across a renewed link for the same screen", () => {
    expect(screenStreamKey("https://app.example.test/novnc/session/control/1.aaa/websockify")).toBe(
      screenStreamKey("https://app.example.test/novnc/session/control/2.bbb/websockify"),
    );
    expect(
      screenStreamKey("https://app.example.test/novnc/session/control/1.aaa/websockify"),
    ).not.toBe(screenStreamKey("https://app.example.test/novnc/session/view/1.aaa/websockify"));
  });
});

describe("proxied screen pages", () => {
  it("probes only screens served through the web server's screen proxy", () => {
    expect(isProxiedScreenPage("https://app.example.test/novnc/session/view/1.t/vnc.html")).toBe(
      true,
    );
    expect(isProxiedScreenPage("https://screen.example.test/embed")).toBe(false);
    expect(isProxiedScreenPage("not a url")).toBe(false);
  });
});
