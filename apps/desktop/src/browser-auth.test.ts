import { get } from "node:http";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBrowserAuth } from "./browser-auth.js";

const controllers: AbortController[] = [];
afterEach(() => {
  for (const controller of controllers) controller.abort();
});
async function setup() {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const callback = `http://127.0.0.1:${address.port}/callback`;
  const authorization = new URL("https://provider.example.com/authorize");
  authorization.searchParams.set("redirect_uri", callback);
  authorization.searchParams.set("state", "test-state");
  const controller = new AbortController();
  controllers.push(controller);
  const onCallback = vi.fn();
  const openExternal = vi.fn(async () => undefined);
  return {
    callback,
    authorization,
    controller,
    options: { signal: controller.signal, onCallback, openExternal, onClose: vi.fn() },
  };
}

describe("system browser authentication", () => {
  it("starts listening before opening the browser and forwards a matching callback", async () => {
    const { authorization, callback, options } = await setup();
    options.openExternal.mockImplementation(async () => {
      const response = await fetch(`${callback}?code=example-code&state=test-state`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("example-code");
    });
    await openBrowserAuth(authorization.href, options);
    expect(options.onCallback).toHaveBeenCalledExactlyOnceWith({
      code: "example-code",
      state: "test-state",
    });
    await expect(fetch(`${callback}?code=replay&state=test-state`)).rejects.toThrow();
    expect(options.onClose).toHaveBeenCalledOnce();
  });

  it("rejects wrong state, path, method and duplicate parameters without consuming the attempt", async () => {
    const { authorization, callback, options } = await setup();
    await openBrowserAuth(authorization.href, options);
    for (const url of [
      `${callback}?code=x&state=wrong`,
      `${callback}/wrong?code=x&state=test-state`,
      `${callback}?code=x&state=test-state&state=wrong`,
      `${callback}?code=x&code=y&state=test-state`,
      `${callback}?error=denied&state=test-state`,
    ])
      expect((await fetch(url)).status).toBe(400);
    expect((await fetch(`${callback}?code=x&state=test-state`, { method: "POST" })).status).toBe(
      400,
    );
    expect(options.onCallback).not.toHaveBeenCalled();
    expect((await fetch(`${callback}?code=x&state=test-state`)).status).toBe(200);
    expect(options.onCallback).toHaveBeenCalledOnce();
  });

  it("accepts localhost callbacks through either loopback address", async () => {
    const { authorization, callback, options } = await setup();
    const localCallback = callback.replace("127.0.0.1", "localhost");
    authorization.searchParams.set("redirect_uri", localCallback);
    await openBrowserAuth(authorization.href, options);
    expect((await fetch(`${localCallback}?code=x&state=test-state`)).status).toBe(200);
    expect(options.onCallback).toHaveBeenCalledOnce();
  });

  it("rejects an unrelated Host header", async () => {
    const { authorization, callback, options } = await setup();
    await openBrowserAuth(authorization.href, options);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      get(
        `${callback}?code=x&state=test-state`,
        {
          headers: { Host: "unrelated.example.com" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      ).on("error", reject);
    });
    expect(status).toBe(400);
    expect(options.onCallback).not.toHaveBeenCalled();
  });

  it("does not open an already cancelled attempt", async () => {
    const { authorization, controller, options } = await setup();
    controller.abort();
    await expect(openBrowserAuth(authorization.href, options)).rejects.toThrow();
    expect(options.openExternal).not.toHaveBeenCalled();
  });

  it("opens device-code flows without a listener", async () => {
    const { options } = await setup();
    await openBrowserAuth("https://provider.example.com/device", options);
    expect(options.openExternal).toHaveBeenCalledWith("https://provider.example.com/device");
    expect(options.onClose).toHaveBeenCalledOnce();
    expect(options.onCallback).not.toHaveBeenCalled();
  });

  it.each([
    "https://remote.example.com/callback",
    "http://0.0.0.0:54321/callback",
    "http://127.0.0.1:80/callback",
    "http://localhost:54321/callback?other=x",
  ])("rejects unsafe redirects: %s", async (redirect) => {
    const { authorization, options } = await setup();
    authorization.searchParams.set("redirect_uri", redirect);
    await expect(openBrowserAuth(authorization.href, options)).rejects.toThrow();
    expect(options.openExternal).not.toHaveBeenCalled();
  });

  it("requires state for automatic capture", async () => {
    const { authorization, options } = await setup();
    authorization.searchParams.delete("state");
    await expect(openBrowserAuth(authorization.href, options)).rejects.toThrow();
  });

  it("closes the listener on cancellation or browser failure", async () => {
    const { authorization, callback, controller, options } = await setup();
    await openBrowserAuth(authorization.href, options);
    controller.abort();
    await expect(fetch(callback)).rejects.toThrow();
    expect(options.onClose).toHaveBeenCalledOnce();
    const retry = await setup();
    retry.options.openExternal.mockRejectedValue(new Error("Browser unavailable"));
    await expect(openBrowserAuth(retry.authorization.href, retry.options)).rejects.toThrow();
    await expect(fetch(retry.callback)).rejects.toThrow();
  });

  it("does not open a browser if the callback port is occupied", async () => {
    const { authorization, options } = await setup();
    await openBrowserAuth(authorization.href, options);
    const second = await setup();
    await expect(openBrowserAuth(authorization.href, second.options)).rejects.toThrow();
    expect(second.options.openExternal).not.toHaveBeenCalled();
  });
});
