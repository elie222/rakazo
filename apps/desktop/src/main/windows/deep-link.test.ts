import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  extractDeepLinkFromArgv,
  navigateWindowToDeepLink,
  parseDeepLink,
  resolveDeepLinkTarget,
  shouldRegisterDeepLinkProtocol,
} from "./deep-link.js";

describe("parseDeepLink", () => {
  it("parses valid rakazo://app/<botId> links with optional query and hash", () => {
    expect(parseDeepLink("rakazo://app/c000000000000000000000001")).toEqual({
      kind: "bot",
      botId: "c000000000000000000000001",
      search: "",
      hash: "",
    });
    expect(parseDeepLink("rakazo://app/bot_1-Alpha?m=msg_42&routine=r1#bottom")).toEqual({
      kind: "bot",
      botId: "bot_1-Alpha",
      search: "?m=msg_42&routine=r1",
      hash: "#bottom",
    });
    expect(parseDeepLink("RAKAZO://APP/BotCase123")).toEqual({
      kind: "bot",
      botId: "BotCase123",
      search: "",
      hash: "",
    });
  });

  it.each([
    ["empty string", ""],
    ["non-rakazo scheme", "https://example.com/app/bot-1"],
    ["javascript scheme", "javascript:alert(1)"],
    ["opaque rakazo without slashes", "rakazo:app/bot-1"],
    ["unknown host billing", "rakazo://billing"],
    ["unknown host sign-in", "rakazo://sign-in"],
    ["unknown host mcp-oauth", "rakazo://mcp-oauth?code=123"],
    ["arbitrary origin host", "rakazo://evil.example/app/bot-1"],
    ["missing bot id", "rakazo://app"],
    ["empty bot id", "rakazo://app/"],
    ["trailing slash", "rakazo://app/bot-1/"],
    ["extra path segments", "rakazo://app/bot-1/settings"],
    ["protocol-relative path", "rakazo://app//evil.example"],
    ["dot traversal", "rakazo://app/.."],
    ["nested dot traversal", "rakazo://app/bot-1/../billing"],
    ["encoded traversal", "rakazo://app/..%2Fbilling"],
    ["encoded slash", "rakazo://app/bot%2Fother"],
    ["backslash in path", "rakazo://app/bot\\other"],
    ["embedded credentials", "rakazo://user:pass@app/bot-1"],
    ["embedded user only", "rakazo://user@app/bot-1"],
    ["explicit port", "rakazo://app:8443/bot-1"],
    ["reserved route board", "rakazo://app/board"],
    ["reserved route artifacts", "rakazo://app/artifacts"],
    ["reserved route group prefix", "rakazo://app/g"],
    ["reserved route nav link prefix", "rakazo://app/x"],
    ["reserved route case-insensitive", "rakazo://app/BOARD"],
    ["control char newline", "rakazo://app/bot-1\n"],
    ["control char null", "rakazo://app/bot-1\u0000"],
    ["leading whitespace", " rakazo://app/bot-1"],
    ["embedded space", "rakazo://app/bot 1"],
    ["overlong bot id", `rakazo://app/${"a".repeat(201)}`],
  ])("rejects %s", (_label, input) => {
    expect(parseDeepLink(input)).toBeNull();
  });
});

describe("extractDeepLinkFromArgv", () => {
  it("extracts a valid deep link from Windows and Linux command lines", () => {
    expect(
      extractDeepLinkFromArgv([
        "C:\\Users\\alice\\AppData\\Local\\Programs\\Rakazo\\Rakazo.exe",
        "--allow-file-access-from-files",
        "rakazo://app/bot-1?m=9",
      ]),
    ).toEqual({
      kind: "bot",
      botId: "bot-1",
      search: "?m=9",
      hash: "",
    });
  });

  it("picks the last valid deep link and ignores invalid rakazo links or flags", () => {
    expect(
      extractDeepLinkFromArgv([
        "/usr/bin/rakazo",
        "rakazo://app/bot-first",
        "rakazo://billing",
        "--flag=rakazo://app/ignored",
        "rakazo://app/bot-second",
      ]),
    ).toEqual({
      kind: "bot",
      botId: "bot-second",
      search: "",
      hash: "",
    });
  });

  it("returns null when no valid deep link is present", () => {
    expect(
      extractDeepLinkFromArgv(["Rakazo.exe", "--headless", "rakazo://billing", "https://x.test"]),
    ).toBeNull();
  });
});

describe("resolveDeepLinkTarget", () => {
  it("resolves against the configured server origin and never lets the link pick an origin", () => {
    const link = parseDeepLink("rakazo://app/bot-123?m=msg-9#top");
    expect(link).not.toBeNull();
    expect(resolveDeepLinkTarget(link!, "https://rakazo.example:8443/some/old/path")).toBe(
      "https://rakazo.example:8443/app/bot-123?m=msg-9#top",
    );
    expect(resolveDeepLinkTarget(link!, "http://127.0.0.1:45173")).toBe(
      "http://127.0.0.1:45173/app/bot-123?m=msg-9#top",
    );
  });

  it("returns null when no valid http(s) target server is configured", () => {
    const link = parseDeepLink("rakazo://app/bot-123")!;
    expect(resolveDeepLinkTarget(link, null)).toBeNull();
    expect(resolveDeepLinkTarget(link, "")).toBeNull();
    expect(resolveDeepLinkTarget(link, "not-a-url")).toBeNull();
    expect(resolveDeepLinkTarget(link, "file:///tmp/index.html")).toBeNull();
    expect(resolveDeepLinkTarget(link, "data:text/html,hi")).toBeNull();
  });
});

describe("shouldRegisterDeepLinkProtocol", () => {
  it("registers only for packaged builds", () => {
    expect(shouldRegisterDeepLinkProtocol(true)).toBe(true);
    expect(shouldRegisterDeepLinkProtocol(false)).toBe(false);
  });
});

describe("navigateWindowToDeepLink", () => {
  function fakeWindow(currentUrl = "https://rakazo.example/app/other") {
    const loadURL = vi.fn(() => Promise.resolve());
    return {
      isDestroyed: vi.fn(() => false),
      webContents: {
        getURL: vi.fn(() => currentUrl),
        loadURL,
      },
    } as unknown as BrowserWindow & {
      webContents: { getURL: ReturnType<typeof vi.fn>; loadURL: ReturnType<typeof vi.fn> };
    };
  }

  it("loads the resolved in-app URL on the existing window", () => {
    const win = fakeWindow("https://rakazo.example/app/other");
    const link = parseDeepLink("rakazo://app/bot-42")!;
    expect(navigateWindowToDeepLink(win, link, "https://rakazo.example")).toBe(true);
    expect(win.webContents.loadURL).toHaveBeenCalledWith("https://rakazo.example/app/bot-42");
  });

  it("skips reloading when the window is already on the exact target URL", () => {
    const win = fakeWindow("https://rakazo.example/app/bot-42");
    const link = parseDeepLink("rakazo://app/bot-42")!;
    expect(navigateWindowToDeepLink(win, link, "https://rakazo.example")).toBe(true);
    expect(win.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("returns false when the window is destroyed or no target server is set", () => {
    const destroyed = fakeWindow();
    (destroyed.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const link = parseDeepLink("rakazo://app/bot-42")!;
    expect(navigateWindowToDeepLink(destroyed, link, "https://rakazo.example")).toBe(false);
    expect(destroyed.webContents.loadURL).not.toHaveBeenCalled();

    const alive = fakeWindow();
    expect(navigateWindowToDeepLink(alive, link, null)).toBe(false);
    expect(alive.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("swallows navigation aborts so rapid deep links do not reject unhandled", async () => {
    const win = fakeWindow();
    win.webContents.loadURL.mockRejectedValueOnce(new Error("ERR_ABORTED"));
    const link = parseDeepLink("rakazo://app/bot-42")!;
    expect(navigateWindowToDeepLink(win, link, "https://rakazo.example")).toBe(true);
    await Promise.resolve();
  });
});
