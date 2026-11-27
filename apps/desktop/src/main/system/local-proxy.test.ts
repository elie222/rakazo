import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { on: vi.fn() },
}));

vi.mock("../ipc/ipc.js", () => ({
  handleIpc: vi.fn(),
}));

import { createLocalWebProxy, isBlockedProxyAddress } from "./local-proxy.js";

describe("desktop local web proxy", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "rakazo-proxy-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("blocks loopback, RFC1918, link-local, and ULA addresses", () => {
    for (const addr of [
      "localhost",
      "sub.localhost",
      "127.0.0.1",
      "10.0.0.5",
      "172.16.1.2",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a00:1",
      "0:0:0:0:0:ffff:7f00:0001",
      "fe80::1",
      "fd12:3456::1",
    ]) {
      expect(isBlockedProxyAddress(addr), addr).toBe(true);
    }
    expect(isBlockedProxyAddress("93.184.216.34")).toBe(false);
    expect(isBlockedProxyAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });

  it("stays off by default, binds loopback on enable, persists, and stops cleanly", async () => {
    const proxy = await createLocalWebProxy({ userDataDir: tmpDir });
    expect(proxy.state()).toEqual({ enabled: false, url: null });

    const enabledState = await proxy.setEnabled(true);
    expect(enabledState.enabled).toBe(true);
    expect(enabledState.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Rejects private/loopback SSRF targets with 403.
    const port = Number(new URL(enabledState.url!).port);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "GET", path: "http://127.0.0.1:80/" },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);

    await proxy.close();

    // A fresh controller restores the persisted enabled state.
    const restored = await createLocalWebProxy({ userDataDir: tmpDir });
    expect(restored.state().enabled).toBe(true);
    expect(restored.state().url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const disabledState = await restored.setEnabled(false);
    expect(disabledState).toEqual({ enabled: false, url: null });
    await restored.close();
  });

  it("serializes concurrent toggles and ignores enables after close", async () => {
    const proxy = await createLocalWebProxy({ userDataDir: tmpDir });
    const [on1, off1, on2] = await Promise.all([
      proxy.setEnabled(true),
      proxy.setEnabled(false),
      proxy.setEnabled(true),
    ]);
    expect(on1.enabled).toBe(true);
    expect(off1.enabled).toBe(false);
    expect(on2.enabled).toBe(true);
    await proxy.close();
    const afterClose = await proxy.setEnabled(true);
    expect(afterClose).toEqual({ enabled: false, url: null });
  });

  it("times out stalled DNS lookups cleanly without hanging the client", async () => {
    const proxy = await createLocalWebProxy({
      userDataDir: tmpDir,
      dnsTimeoutMs: 50,
      dnsLookup: () => new Promise(() => {}),
    });
    const state = await proxy.setEnabled(true);
    const port = Number(new URL(state.url!).port);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "GET", path: "http://stalled.example.test/" },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(502);
    await proxy.close();
  });
});
