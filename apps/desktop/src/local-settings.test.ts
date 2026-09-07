import { LOCAL_SETTINGS_RPC, LOCAL_SETTINGS_TOKEN_HEADER } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { requestLocalSettings } from "./local-settings.js";

const target = { origin: "http://127.0.0.1:5173", token: "ab".repeat(32) };
const pathname = `${LOCAL_SETTINGS_RPC}/models/connect`;
describe("local settings transport", () => {
  it("sends only the scoped capability, without cookies or following redirects", async () => {
    const fetcher = vi.fn(async () => new Response('{"json":{"ok":true}}'));
    expect(await requestLocalSettings(target, pathname, '{"json":{}}', fetcher)).toEqual({
      status: 200,
      body: '{"json":{"ok":true}}',
    });
    expect(fetcher).toHaveBeenCalledWith(
      target.origin + pathname,
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          [LOCAL_SETTINGS_TOKEN_HEADER]: target.token,
        },
      }),
    );
  });
  it("rejects remote targets, arbitrary procedures, and oversized payloads before sending", async () => {
    const fetcher = vi.fn();
    for (const path of [
      "/rpc/bots/list",
      `${LOCAL_SETTINGS_RPC}/bots/list`,
      `${pathname}?redirect=1`,
      "https://example.test",
    ]) {
      await expect(requestLocalSettings(target, path, "{}", fetcher)).rejects.toThrow();
    }
    await expect(
      requestLocalSettings({ ...target, origin: "https://example.test" }, pathname, "{}", fetcher),
    ).rejects.toThrow();
    await expect(
      requestLocalSettings(target, pathname, "x".repeat(1024 * 1024 + 1), fetcher),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
