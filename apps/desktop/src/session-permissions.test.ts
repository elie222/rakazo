import type { Session, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { installSessionPermissions } from "./session-permissions.js";
import { shouldOpenInAppPopup } from "./window-open.js";

const appUrl = "https://app.example.test/chat";
const providerUrl = "https://provider.example.test/authorize";
type RequestHandler = NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;
type CheckHandler = NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;

function policyFixture(url = appUrl) {
  const setPermissionRequestHandler = vi.fn<Session["setPermissionRequestHandler"]>();
  const setPermissionCheckHandler = vi.fn<Session["setPermissionCheckHandler"]>();
  const session = {
    setPermissionRequestHandler,
    setPermissionCheckHandler,
  } as unknown as Session;
  const contents = {
    session,
    isDestroyed: vi.fn(() => false),
    getURL: vi.fn(() => url),
  } as unknown as WebContents;
  let app: { webContents: WebContents; url: string } | null = { webContents: contents, url };
  installSessionPermissions(session, () => app);
  const requestHandler = setPermissionRequestHandler.mock.calls[0]?.[0] as RequestHandler;
  const checkHandler = setPermissionCheckHandler.mock.calls[0]?.[0] as CheckHandler;
  return {
    contents,
    session,
    setApp: (next: typeof app) => {
      app = next;
    },
    request(
      permission: Parameters<RequestHandler>[1] = "media",
      details: Partial<Parameters<RequestHandler>[3]> = {},
      sender = contents,
    ) {
      const callback = vi.fn();
      requestHandler(sender, permission, callback, {
        requestingUrl: url,
        isMainFrame: true,
        securityOrigin: new URL(url).origin,
        mediaTypes: ["audio"],
        ...details,
      });
      expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(Boolean));
      return callback.mock.calls[0]?.[0];
    },
    check(
      permission: Parameters<CheckHandler>[1] = "media",
      details: Partial<Parameters<CheckHandler>[3]> = {},
      sender: WebContents | null = contents,
      requestingOrigin = new URL(url).origin,
    ) {
      return checkHandler(sender, permission, requestingOrigin, {
        requestingUrl: url,
        isMainFrame: true,
        securityOrigin: new URL(url).origin,
        mediaType: "audio",
        ...details,
      });
    },
  };
}

describe("desktop session permissions", () => {
  it.each([
    appUrl,
    "http://127.0.0.1:5173/chat",
    "http://localhost:5173/chat",
    "http://[::1]:5173/chat",
    "https://192.168.1.20:3100/chat",
  ])("preserves microphone, notifications and copy in the connected app at %s", (url) => {
    const policy = policyFixture(url);
    for (const permission of ["media", "notifications", "clipboard-sanitized-write"] as const) {
      expect(policy.request(permission)).toBe(true);
      expect(policy.check(permission)).toBe(true);
    }
  });

  it.each([
    "http://192.168.1.20:3100/chat",
    "http://10.0.0.20:3100/chat",
    "http://[fd00::20]:3100/chat",
    "http://server.local:3100/chat",
    "http://app.example.test/chat",
  ])("denies permissions to a connected app over non-loopback HTTP: %s", (url) => {
    const policy = policyFixture(url);
    for (const permission of ["media", "notifications", "clipboard-sanitized-write"] as const) {
      expect(policy.request(permission)).toBe(false);
      expect(policy.check(permission)).toBe(false);
    }
    expect(policy.check("notifications", { embeddingOrigin: url }, null)).toBe(false);
  });

  it.each([
    "rakazo-model-oauth",
    "rakazo-mcp-oauth",
    "rakazo-app-connect",
    "rakazo-plugin-connect",
  ])("allows %s navigation without granting permissions to its popup", (name) => {
    const policy = policyFixture();
    expect(shouldOpenInAppPopup(new URL(appUrl).origin, providerUrl, name)).toBe(true);
    const popup = { ...policy.contents, getURL: () => providerUrl } as WebContents;
    for (const permission of ["media", "notifications", "clipboard-sanitized-write"] as const) {
      expect(policy.request(permission, { requestingUrl: providerUrl }, popup)).toBe(false);
      expect(policy.check(permission, { requestingUrl: providerUrl }, popup)).toBe(false);
      // A same-origin callback or forged first-party URL does not turn a popup into the app.
      expect(policy.request(permission, {}, popup)).toBe(false);
      expect(policy.check(permission, {}, popup)).toBe(false);
    }
  });

  it("denies both same-origin and third-party subframes", () => {
    const policy = policyFixture();
    for (const requestingUrl of [appUrl, providerUrl]) {
      expect(policy.request("media", { requestingUrl, isMainFrame: false })).toBe(false);
      expect(policy.check("media", { requestingUrl, isMainFrame: false })).toBe(false);
      expect(policy.check("media", { requestingUrl, isMainFrame: false }, null)).toBe(false);
    }
  });

  it.each([
    "https://app.example.test.attacker.test/chat",
    "https://app.example.test:444/chat",
    "http://app.example.test/chat",
    "https://app.example.test@attacker.test/chat",
    "blob:https://app.example.test/id",
    "data:text/html,example",
    "about:blank",
    "file:///example.html",
    "not a url",
    "null",
    "",
  ])("rejects untrusted or opaque requesting origins: %s", (url) => {
    const policy = policyFixture();
    expect(policy.request("media", { requestingUrl: url })).toBe(false);
    expect(policy.request("media", { securityOrigin: url })).toBe(false);
    expect(policy.check("media", {}, policy.contents, url)).toBe(false);
    expect(policy.check("media", { requestingUrl: url })).toBe(false);
    expect(policy.check("media", { securityOrigin: url })).toBe(false);
    expect(policy.check("media", { embeddingOrigin: url })).toBe(false);
  });

  it.each([undefined, [], ["video"], ["audio", "video"], ["unknown"]])(
    "rejects camera and ambiguous media requests: %j",
    (mediaTypes) => {
      expect(policyFixture().request("media", { mediaTypes })).toBe(false);
    },
  );

  it.each([undefined, "video", "unknown"])("rejects media checks for %s", (mediaType) => {
    expect(policyFixture().check("media", { mediaType })).toBe(false);
  });

  it("fails closed when frame or media origin metadata is missing", () => {
    const policy = policyFixture();
    expect(policy.request("media", { securityOrigin: undefined })).toBe(false);
    expect(policy.request("media", { requestingUrl: undefined })).toBe(false);
    expect(policy.request("media", { isMainFrame: undefined })).toBe(false);
    expect(policy.check("media", { requestingUrl: undefined })).toBe(false);
    expect(policy.check("media", { isMainFrame: undefined })).toBe(false);
  });

  it.each([
    "clipboard-read",
    "display-capture",
    "geolocation",
    "fullscreen",
    "fileSystem",
    "openExternal",
    "storage-access",
    "unknown",
  ] as const)("denies unused permission %s even in the app", (permission) => {
    const policy = policyFixture();
    expect(policy.request(permission)).toBe(false);
    // Electron's request/check permission unions differ; unknown strings must also fail closed.
    expect(policy.check(permission as Parameters<CheckHandler>[1])).toBe(false);
  });

  it("handles origin-only notification checks without allowing other capabilities", () => {
    const policy = policyFixture();
    const details = {
      requestingUrl: undefined,
      isMainFrame: false,
      securityOrigin: undefined,
      embeddingOrigin: new URL(appUrl).origin,
    };
    expect(policy.check("notifications", details, null)).toBe(true);
    expect(policy.check("media", details, null)).toBe(false);
    expect(policy.check("clipboard-sanitized-write", details, null)).toBe(false);
    expect(policy.check("notifications", details, null, providerUrl)).toBe(false);
    expect(policy.check("notifications", { ...details, embeddingOrigin: providerUrl }, null)).toBe(
      false,
    );
    expect(policy.check("notifications", { ...details, embeddingOrigin: undefined }, null)).toBe(
      false,
    );
  });

  it("denies setup and storage probes before an app exists", () => {
    const policy = policyFixture();
    policy.setApp(null);
    expect(policy.request()).toBe(false);
    expect(policy.check()).toBe(false);
    expect(policy.check("notifications", { embeddingOrigin: appUrl }, null)).toBe(false);
  });

  it("revokes grants if the app is destroyed or navigates to another origin", () => {
    const policy = policyFixture();
    vi.mocked(policy.contents.getURL).mockReturnValue(providerUrl);
    expect(policy.request()).toBe(false);
    expect(policy.check()).toBe(false);
    vi.mocked(policy.contents.getURL).mockReturnValue(appUrl);
    vi.mocked(policy.contents.isDestroyed).mockReturnValue(true);
    expect(policy.request()).toBe(false);
    expect(policy.check()).toBe(false);
  });

  it.each(["data:text/html,example", "file:///example.html", "not a url"])(
    "does not trust an opaque or invalid configured target: %s",
    (url) => {
      const policy = policyFixture();
      policy.setApp({ webContents: policy.contents, url });
      vi.mocked(policy.contents.getURL).mockReturnValue(url);
      expect(policy.request()).toBe(false);
      expect(policy.check()).toBe(false);
    },
  );

  it("does not carry grants across server switches, even in the legacy default session", () => {
    const policy = policyFixture();
    const nextContents = { ...policy.contents, getURL: () => providerUrl } as WebContents;
    policy.setApp({ webContents: nextContents, url: providerUrl });
    expect(policy.request()).toBe(false);
    expect(policy.check()).toBe(false);
    expect(policy.check("notifications", { embeddingOrigin: appUrl }, null)).toBe(false);
    policy.setApp({ webContents: policy.contents, url: appUrl });
    expect(policy.request()).toBe(true);
    expect(policy.check()).toBe(true);
  });

  it("does not grant permissions through a different session partition", () => {
    const policy = policyFixture();
    const other = policyFixture();
    policy.setApp({ webContents: other.contents, url: appUrl });
    expect(policy.request("media", {}, other.contents)).toBe(false);
    expect(policy.check("media", {}, other.contents)).toBe(false);
    expect(policy.check("notifications", { embeddingOrigin: appUrl }, null)).toBe(false);
  });
});
