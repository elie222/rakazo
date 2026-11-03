import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceTokenCipher } from "./user-device.js";
import {
  createUserDeviceAccess,
  deletePairedDevice,
  readDeviceConsent,
  readPairedDevice,
  saveDeviceConsent,
  savePairedDevice,
} from "./user-device.js";

const origin = "https://rakazo.example.com";
const other = "https://other.example.com";

// Reversible stand-in for OS encryption that still keeps the plaintext off disk.
const cipher: DeviceTokenCipher = {
  available: async () => true,
  encrypt: async (value) => Buffer.from(value.split("").reverse().join("")),
  decrypt: async (value) => value.toString().split("").reverse().join(""),
};

let userData: string;
beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "rakazo-device-"));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("device token storage", () => {
  it("keeps one encrypted, owner-only token per server origin", async () => {
    await savePairedDevice(userData, origin, { token: "secret-token", deviceId: "d1" }, cipher);
    await savePairedDevice(userData, other, { token: "other-token", deviceId: null }, cipher);
    expect(await readPairedDevice(userData, origin, cipher)).toEqual({
      token: "secret-token",
      deviceId: "d1",
    });
    expect((await readPairedDevice(userData, other, cipher))?.token).toBe("other-token");
    const dir = path.join(userData, "devices");
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name);
      expect(await readFile(file, "utf8")).not.toContain("secret-token");
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o077).toBe(0);
    }
    await deletePairedDevice(userData, origin);
    expect(await readPairedDevice(userData, origin, cipher)).toBeNull();
    expect((await readPairedDevice(userData, other, cipher))?.token).toBe("other-token");
  });

  it("refuses to store a token without secure storage and ignores undecryptable ones", async () => {
    const device = { token: "t", deviceId: null };
    await expect(
      savePairedDevice(userData, origin, device, { ...cipher, available: async () => false }),
    ).rejects.toThrow();
    expect(await readPairedDevice(userData, origin, cipher)).toBeNull();
    await savePairedDevice(userData, origin, device, cipher);
    expect(
      await readPairedDevice(userData, origin, {
        ...cipher,
        decrypt: async () => {
          throw new Error("locked");
        },
      }),
    ).toBeNull();
  });

  it("keeps this computer's consent per server origin", async () => {
    expect(await readDeviceConsent(userData, origin)).toBeNull();
    await saveDeviceConsent(userData, origin, "allowed");
    await saveDeviceConsent(userData, other, "declined");
    expect(await readDeviceConsent(userData, origin)).toBe("allowed");
    expect(await readDeviceConsent(userData, other)).toBe("declined");
  });
});

describe("remote computer access", () => {
  const accesses: ReturnType<typeof createUserDeviceAccess>[] = [];
  // select() pairs in the background; its token write must land before the directory is removed.
  afterEach(async () => {
    await Promise.all(accesses.splice(0).map((access) => access.pair()));
  });

  function setup(overrides: Partial<Parameters<typeof createUserDeviceAccess>[0]> = {}) {
    const requests: { url: string; init: RequestInit }[] = [];
    const clients: {
      origin: string;
      token: string;
      closed: boolean;
      cancelled: number;
      revoke: () => void;
      authorize: () => Promise<boolean>;
    }[] = [];
    const access = createUserDeviceAccess({
      userDataDir: userData,
      cipher,
      device: async () => ({ name: "Test Mac", platform: "darwin" }),
      confirm: async () => true,
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (url.endsWith("/api/devices/pair"))
          return Response.json({ deviceId: "device-1", token: "device-token" });
        return new Response(null, { status: 204 });
      },
      connect: (serverOrigin, token, events) => {
        const client = {
          origin: serverOrigin,
          token,
          closed: false,
          cancelled: 0,
          revoke: events.onRevoked,
          authorize: events.authorize,
        };
        clients.push(client);
        return {
          close: () => {
            client.closed = true;
          },
          cancelAll: () => {
            client.cancelled += 1;
          },
        };
      },
      ...overrides,
    });
    accesses.push(access);
    return { access, requests, clients };
  }

  it("pairs with the window session on its own and connects without granting anything", async () => {
    const confirm = vi.fn(async () => true);
    const { access, requests, clients } = setup({ confirm });
    await access.select(origin);
    await access.pair();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${origin}/api/devices/pair`);
    expect(requests[0]!.init).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      name: "Test Mac",
      platform: "darwin",
    });
    expect(clients).toMatchObject([{ origin, token: "device-token", closed: false }]);
    expect(access.state(origin)).toEqual({ deviceId: "device-1", allowed: false });
    expect(access.state(other)).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(await readPairedDevice(userData, origin, cipher)).toEqual({
      token: "device-token",
      deviceId: "device-1",
    });
  });

  it("asks once on the first request, keeps the answer, and lets waiting requests share it", async () => {
    let answer: (allowed: boolean) => void = () => undefined;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const { access, clients } = setup({ confirm });
    await access.select(origin);
    await access.pair();
    const first = clients[0]!.authorize();
    const second = clients[0]!.authorize();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith("rakazo.example.com");
    answer(true);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(await clients[0]!.authorize()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(access.state(origin)?.allowed).toBe(true);
    expect(await readDeviceConsent(userData, origin)).toBe("allowed");

    const relaunched = setup({ confirm });
    await relaunched.access.select(origin);
    expect(await relaunched.clients[0]!.authorize()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("refuses every request after Cancel without asking again, until turned back on", async () => {
    const confirm = vi.fn(async () => false);
    const { access, clients } = setup({ confirm });
    await access.select(origin);
    await access.pair();
    expect(await clients[0]!.authorize()).toBe(false);
    expect(await clients[0]!.authorize()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await readDeviceConsent(userData, origin)).toBe("declined");

    confirm.mockResolvedValue(true);
    await access.setAllowed(origin, true);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await clients[0]!.authorize()).toBe(true);
    await access.setAllowed(origin, false);
    expect(await clients[0]!.authorize()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(access.state(origin)).toEqual({ deviceId: "device-1", allowed: false });
  });

  it("stops running and waiting work, but keeps the connection, when turned off", async () => {
    await saveDeviceConsent(userData, origin, "allowed");
    const { access, clients } = setup();
    await access.select(origin);
    await access.pair();
    await access.setAllowed(origin, false);
    expect(clients).toMatchObject([{ closed: false, cancelled: 1 }]);
    expect(await clients[0]!.authorize()).toBe(false);
  });

  it("ignores a prompt answered after access was turned off or revoked", async () => {
    let answer: (allowed: boolean) => void = () => undefined;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const { access, clients, requests } = setup({ confirm });
    await access.select(origin);
    await access.pair();
    const waiting = clients[0]!.authorize();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await access.setAllowed(origin, false);
    answer(true);
    expect(await waiting).toBe(false);
    expect(await readDeviceConsent(userData, origin)).toBe("declined");

    const turningOn = access.setAllowed(origin, true);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    clients[0]!.revoke();
    answer(true);
    await turningOn;
    expect(await readDeviceConsent(userData, origin)).toBe("declined");
    expect(access.state(origin)).toEqual({ deviceId: null, allowed: false });
    expect(requests.filter(({ url }) => url.endsWith("/pair"))).toHaveLength(1);
  });

  it("fails turning on and stays off when pairing fails", async () => {
    await saveDeviceConsent(userData, origin, "declined");
    let status = 409;
    const fetch = vi.fn(async () =>
      status === 200
        ? Response.json({ deviceId: "device-1", token: "device-token" })
        : new Response(null, { status }),
    );
    const { access, clients } = setup({ fetch });
    await access.select(origin);
    await expect(access.setAllowed(origin, true)).rejects.toThrow();
    expect(access.state(origin)).toEqual({ deviceId: null, allowed: false });
    expect(await readDeviceConsent(userData, origin)).toBe("declined");
    status = 200;
    await access.setAllowed(origin, true);
    expect(access.state(origin)).toEqual({ deviceId: "device-1", allowed: true });
    expect(clients).toHaveLength(1);
  });

  it("keeps access off when it is turned off while pairing", async () => {
    await saveDeviceConsent(userData, origin, "declined");
    let respond: () => void = () => undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = () => resolve(Response.json({ deviceId: "device-1", token: "device-token" }));
        }),
    );
    const { access } = setup({ fetch, confirm: async () => true });
    await access.select(origin);
    const turningOn = access.setAllowed(origin, true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await access.setAllowed(origin, false);
    respond();
    await turningOn;
    expect(await readDeviceConsent(userData, origin)).toBe("declined");
    expect(access.state(origin)?.allowed).toBe(false);
  });

  it("ignores a page asking for a server it no longer shows", async () => {
    const confirm = vi.fn(async () => true);
    let respond = () => {};
    let pairingStarted = () => {};
    const started = new Promise<void>((resolve) => {
      pairingStarted = resolve;
    });
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = () => resolve(Response.json({ deviceId: "device-1", token: "device-token" }));
          pairingStarted();
        }),
    );
    const { access, clients } = setup({ confirm, fetch });
    await access.select(origin);
    const pairing = access.pair();
    await started;
    try {
      await access.setAllowed(other, true);
      expect(confirm).not.toHaveBeenCalled();
      expect(await readDeviceConsent(userData, other)).toBeNull();
    } finally {
      respond();
      await pairing;
    }
    expect(clients).toHaveLength(1);
    expect(await readPairedDevice(userData, origin, cipher)).toEqual({
      token: "device-token",
      deviceId: "device-1",
    });
  });

  it("retries a signed-out pairing on the next page load but not a refused one", async () => {
    let status = 401;
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/api/devices/pair") && status === 200
        ? Response.json({ deviceId: "device-1", token: "device-token" })
        : new Response(null, { status }),
    );
    const { access, clients } = setup({ fetch });
    await access.select(origin);
    await access.pair();
    expect(clients).toEqual([]);
    status = 200;
    await access.pair();
    expect(clients).toHaveLength(1);

    const refused = setup({ fetch });
    status = 404;
    await refused.access.select(other);
    await refused.access.pair();
    await refused.access.pair();
    expect(fetch.mock.calls.filter(([url]) => url.startsWith(other))).toHaveLength(1);
  });

  it("never pairs without secure storage", async () => {
    const { access, requests } = setup({ cipher: { ...cipher, available: async () => false } });
    await access.select(origin);
    await access.pair();
    expect(requests).toEqual([]);
  });

  it("reconnects on launch, disconnects when switching servers, and stops on close", async () => {
    await savePairedDevice(userData, origin, { token: "saved-token", deviceId: "d1" }, cipher);
    await saveDeviceConsent(userData, other, "declined");
    const { access, clients, requests } = setup();
    await access.select(origin);
    expect(clients).toMatchObject([{ origin, token: "saved-token", closed: false }]);
    await access.select(other);
    await access.pair();
    expect(clients[0]!.closed).toBe(true);
    expect(clients).toHaveLength(1);
    expect(requests).toEqual([]);
    await access.select(origin);
    expect(clients).toHaveLength(2);
    access.close();
    expect(clients[1]!.closed).toBe(true);
  });

  it("forgets a revoked token and stays unpaired until turned back on", async () => {
    await savePairedDevice(userData, origin, { token: "saved-token", deviceId: "d1" }, cipher);
    await saveDeviceConsent(userData, origin, "allowed");
    const confirm = vi.fn(async () => true);
    const { access, clients, requests } = setup({ confirm });
    await access.select(origin);
    clients[0]!.revoke();
    await vi.waitFor(async () =>
      expect(await readPairedDevice(userData, origin, cipher)).toBeNull(),
    );
    await vi.waitFor(async () =>
      expect(await readDeviceConsent(userData, origin)).toBe("declined"),
    );
    expect(access.state(origin)).toEqual({ deviceId: null, allowed: false });
    await access.pair();
    expect(requests).toEqual([]);

    await access.setAllowed(origin, true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(access.state(origin)).toEqual({ deviceId: "device-1", allowed: true });
    expect(clients.at(-1)).toMatchObject({ token: "device-token", closed: false });
  });
});
