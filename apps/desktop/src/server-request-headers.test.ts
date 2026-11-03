import type { DesktopSetup } from "@rakazo/contracts";
import type { Session } from "electron";
import { describe, expect, it, vi } from "vitest";
import { installServerHeaders } from "./server-request-headers.js";

const setup: DesktopSetup = {
  mode: "existing",
  serverUrl: "https://server.example:8443",
  headers: { "X-Access-Token": "fake-secret" },
};

function hook(config: DesktopSetup | null = setup) {
  const register = vi.fn();
  installServerHeaders(
    { webRequest: { onBeforeSendHeaders: register } } as unknown as Session,
    () => config,
    () => 7,
  );
  return register;
}

describe("server header hook", () => {
  it("does not register without configured headers", () => {
    expect(hook(null)).not.toHaveBeenCalled();
    expect(hook({ ...setup, headers: {} })).not.toHaveBeenCalled();
    expect(hook({ mode: "existing", serverUrl: setup.serverUrl })).not.toHaveBeenCalled();
  });

  it("scopes each request and redirected request to the exact origin and app", () => {
    const handler = hook().mock.calls[0]![0];
    const send = (url: string, webContentsId = 7, frameUrl = setup.serverUrl) => {
      const callback = vi.fn();
      handler(
        {
          url,
          webContentsId,
          frame: { url: frameUrl },
          requestHeaders: { "x-access-token": "inherited-secret", Accept: "*/*" },
        },
        callback,
      );
      return callback.mock.calls[0]![0].requestHeaders;
    };
    expect(send("https://server.example:8443/rpc/me")).toEqual({
      Accept: "*/*",
      "X-Access-Token": "fake-secret",
    });
    expect(send("wss://server.example:8443/screen")).toHaveProperty("X-Access-Token");
    const nativeCallback = vi.fn();
    handler({ url: setup.serverUrl, webContentsId: -1, requestHeaders: {} }, nativeCallback);
    expect(nativeCallback.mock.calls[0]![0].requestHeaders).toEqual({});
    for (const url of [
      "https://server.example/rpc",
      "http://server.example:8443/rpc",
      "https://server.example.evil:8443/rpc",
      "https://other.example/rpc",
      "devtools://devtools/",
      "chrome-extension://example/",
    ])
      expect(send(url)).toEqual({ Accept: "*/*" });
    expect(send("https://server.example:8443/rpc", 8)).toEqual({ Accept: "*/*" });
    for (const frame of ["devtools://devtools/", "chrome-extension://example/"]) {
      expect(send("https://server.example:8443/rpc", 7, frame)).toEqual({ Accept: "*/*" });
    }
  });
});
