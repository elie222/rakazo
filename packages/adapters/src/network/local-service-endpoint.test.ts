import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { describe, expect, it, vi } from "vitest";
import { MemoryProviderPrivateEndpointRequiredError } from "../providers/memory/serenity/serenity-memory-provider.js";
import type { LocalServiceConnection } from "./local-service-endpoint.js";
import {
  classifyLocalServiceSettings,
  fetchLocalService,
  LocalServiceHost,
  pinLocalServiceHost,
} from "./local-service-endpoint.js";
import type { ResolvedAddress } from "./network-address.js";

const baseUrl = "http://memory.example.test:8888";
const publicUrl = "https://memory.example.test";
const answers = (...addresses: string[]) =>
  vi.fn(
    async (): Promise<ResolvedAddress[]> =>
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  );

describe("private memory DNS deadlines", () => {
  it("bounds DNS even for callers without an operation signal", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const resolveHostname = vi.fn(() => new Promise<ResolvedAddress[]>(() => {}));
    try {
      const pin = pinLocalServiceHost(baseUrl, { allowPrivateEndpoint: true, resolveHostname });
      const rejected = expect(pin).rejects.toThrow("did not resolve");
      expect(resolveHostname).toHaveBeenCalledOnce();
      deadline.abort();
      await rejected;
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("does not discard a shared bounded pin when one caller is cancelled", async () => {
    let finish!: Deferred<ResolvedAddress[]>;
    const resolveHostname = vi.fn(() => {
      finish = deferred<ResolvedAddress[]>();
      return finish.promise;
    });
    const host = new LocalServiceHost(baseUrl, "private", resolveHostname);
    const cancelled = new AbortController();
    const first = host.block(cancelled.signal);
    const second = host.block();
    cancelled.abort(new Error("caller stopped"));
    expect(await first).toBe("caller stopped");
    finish.resolve([{ address: "10.0.0.2", family: 4 }]);
    expect(await second).toBeNull();
    expect(await host.block()).toBeNull();
    expect(resolveHostname).toHaveBeenCalledOnce();
    expect(host.withPin<LocalServiceConnection>({ baseUrl }).pinnedAddresses).toEqual([
      { address: "10.0.0.2", family: 4 },
    ]);
  });
});

describe("self-hosted trust by resolved address", () => {
  it("reaches a public HTTPS server without the private-endpoint setting, pinned", async () => {
    await expect(
      pinLocalServiceHost(publicUrl, { resolveHostname: answers("203.0.113.10") }),
    ).resolves.toEqual({
      trust: "public",
      pinnedAddresses: [{ address: "203.0.113.10", family: 4 }],
    });
    await expect(pinLocalServiceHost("https://203.0.113.10")).resolves.toEqual({
      trust: "public",
    });
  });

  it("needs the setting for a public-looking name that resolves privately", async () => {
    for (const address of ["10.0.0.5", "127.0.0.1", "fd00::1"]) {
      await expect(
        pinLocalServiceHost(publicUrl, { resolveHostname: answers(address) }),
      ).rejects.toBeInstanceOf(MemoryProviderPrivateEndpointRequiredError);
    }
    await expect(
      pinLocalServiceHost("https://192.168.1.20", { resolveHostname: answers() }),
    ).rejects.toBeInstanceOf(MemoryProviderPrivateEndpointRequiredError);
  });

  it("refuses mixed, metadata and cleartext public answers whatever the setting", async () => {
    await expect(
      pinLocalServiceHost(publicUrl, {
        allowPrivateEndpoint: true,
        resolveHostname: answers("203.0.113.10", "10.0.0.5"),
      }),
    ).rejects.toThrow("private-network");
    await expect(
      pinLocalServiceHost(publicUrl, {
        allowPrivateEndpoint: true,
        resolveHostname: answers("169.254.169.254"),
      }),
    ).rejects.toThrow("blocked");
    await expect(
      pinLocalServiceHost("http://memory.example.test", {
        resolveHostname: answers("203.0.113.10"),
      }),
    ).rejects.toThrow("HTTPS");
  });

  it("refuses a saved public server that now resolves privately", async () => {
    const host = new LocalServiceHost(publicUrl, "public", answers("10.0.0.5"));
    expect(await host.block()).toMatch(/public address/);
  });

  it("marks only a classified public server public, ignoring a submitted mark", async () => {
    vi.resetModules();
    vi.doMock("node:dns/promises", () => ({
      lookup: vi.fn(async (host: string) => [
        { address: host.startsWith("lan.") ? "10.0.0.5" : "203.0.113.10", family: 4 },
      ]),
    }));
    try {
      const { classifyLocalServiceSettings: classify } = await import(
        "./local-service-endpoint.js"
      );
      await expect(classify({ mode: "local", baseUrl: publicUrl })).resolves.toEqual({
        mode: "local",
        baseUrl: publicUrl,
        endpointTrust: "public",
      });
      await expect(
        classify({
          mode: "local",
          baseUrl: "https://lan.example.test",
          endpointTrust: "public",
        }),
      ).resolves.toEqual({ mode: "local", baseUrl: "https://lan.example.test" });
    } finally {
      vi.doUnmock("node:dns/promises");
      vi.resetModules();
    }
    await expect(
      classifyLocalServiceSettings({ mode: "cloud", endpointTrust: "public" }),
    ).resolves.toEqual({ mode: "cloud" });
  });

  it("sends public requests only to the pinned public addresses", async () => {
    const transport = vi.fn(async () => new Response("ok"));
    const connection: LocalServiceConnection = {
      baseUrl: publicUrl,
      trust: "public",
      pinnedAddresses: [{ address: "10.0.0.5", family: 4 }],
      fetch: transport,
    };
    await expect(fetchLocalService(connection, `${publicUrl}/v1`, {})).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    const response = await fetchLocalService(
      { ...connection, pinnedAddresses: [{ address: "203.0.113.10", family: 4 }] },
      `${publicUrl}/v1`,
      {},
    );
    expect(await response.text()).toBe("ok");
    expect(transport).toHaveBeenCalledOnce();
  });
});
