import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_RETRY_AFTER_MS } from "@rakazo/core";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as setupStore from "../setup/setup-store.js";
import type { DeviceTokenCipher } from "./user-device.js";
import {
  createUserDeviceAccess,
  deletePairedDevice,
  readDeviceConsent,
  readPairedDevice,
  saveDeviceConsent,
  savePairedDevice,
} from "./user-device.js";

vi.mock("../setup/setup-store.js", async (actual) => {
  const store = await actual<typeof setupStore>();
  return { ...store, writePrivateFile: vi.fn(store.writePrivateFile) };
});

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
  vi.useRealTimers();
  await rm(userData, { recursive: true, force: true, maxRetries: 5 });
});

describe("device token storage", () => {
  it("keeps one encrypted, owner-only token per server origin", async () => {
    await savePairedDevice(
      userData,
      origin,
      { token: "secret-token", deviceId: "d1", userId: "user-1" },
      cipher,
    );
    await savePairedDevice(
      userData,
      other,
      { token: "other-token", deviceId: null, userId: null },
      cipher,
    );
    expect(await readPairedDevice(userData, origin, cipher)).toEqual({
      token: "secret-token",
      deviceId: "d1",
      userId: "user-1",
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
    const device = { token: "t", deviceId: null, userId: null };
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

  it("keeps this computer's consent per server origin, with the account it was given for", async () => {
    expect(await readDeviceConsent(userData, origin)).toBeNull();
    await saveDeviceConsent(userData, origin, { consent: "allowed", userId: "user-1" });
    await saveDeviceConsent(userData, other, { consent: "declined", userId: null });
    expect(await readDeviceConsent(userData, origin)).toEqual({
      consent: "allowed",
      userId: "user-1",
    });
    expect(await readDeviceConsent(userData, other)).toEqual({ consent: "declined", userId: null });
  });

  it("asks again when a decline was saved before accounts were, since the server's sign-out wrote those too", async () => {
    await saveDeviceConsent(userData, origin, { consent: "declined", userId: null });
    await saveDeviceConsent(userData, other, { consent: "allowed", userId: null });
    const dir = path.join(userData, "devices");
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name);
      const { userId: _, ...legacy } = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify(legacy));
    }
    expect(await readDeviceConsent(userData, origin)).toBeNull();
    expect(await readDeviceConsent(userData, other)).toEqual({ consent: "allowed", userId: null });
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
      revoke: (reason?: "session-ended") => void;
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

  it("does not pair or grant computer access to a cleartext remote server", async () => {
    const fetch = vi.fn();
    const confirm = vi.fn(async () => true);
    const { access, clients } = setup({ fetch, confirm });
    const remote = "http://192.168.1.20:3100";
    await access.select(remote);
    await access.pair();
    await access.setAllowed(remote, true);
    expect(access.state(remote)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(clients).toHaveLength(0);
  });

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
      pairingKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(clients).toMatchObject([{ origin, token: "device-token", closed: false }]);
    expect(access.state(origin)).toEqual({ deviceId: "device-1", allowed: false });
    expect(access.state(other)).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(await readPairedDevice(userData, origin, cipher)).toEqual({
      token: "device-token",
      deviceId: "device-1",
      userId: null,
    });
  });

  it.each(["settings", "request"] as const)(
    "saves consent before permission setup from %s, so a restart keeps it",
    async (source) => {
      const prepareAccess = vi.fn(async () => {
        expect(await readDeviceConsent(userData, origin)).toMatchObject({ consent: "allowed" });
        expect(access.state(origin)?.allowed).toBe(true);
      });
      const { access, clients } = setup({ prepareAccess });
      await access.select(origin);
      await access.pair();
      if (source === "settings") await access.setAllowed(origin, true);
      else expect(await clients[0]!.authorize()).toBe(true);
      expect(prepareAccess).toHaveBeenCalledOnce();
      await prepareAccess.mock.results[0]!.value;
    },
  );

  it.each(["settings", "request"] as const)(
    "does not offer setup or authorize access when saving consent from %s fails",
    async (source) => {
      const prepareAccess = vi.fn(async () => undefined);
      const { access, clients } = setup({ prepareAccess });
      await access.select(origin);
      await access.pair();
      const failure = Object.assign(new Error("Permission denied"), { code: "EACCES" });
      vi.mocked(setupStore.writePrivateFile).mockRejectedValueOnce(failure);
      const request =
        source === "settings" ? access.setAllowed(origin, true) : clients[0]!.authorize();
      await expect(request).rejects.toBe(failure);
      expect(prepareAccess).not.toHaveBeenCalled();
      expect(access.state(origin)?.allowed).toBe(false);
      expect(await readDeviceConsent(userData, origin)).toBeNull();
    },
  );

  it("refuses requests sharing an approval when its consent write fails", async () => {
    const answer = deferred<boolean>();
    const written = deferred<void>();
    const confirm = vi.fn(() => answer.promise);
    const prepareAccess = vi.fn(async () => undefined);
    const { access, clients } = setup({ confirm, prepareAccess });
    await access.select(origin);
    await access.pair();
    vi.mocked(setupStore.writePrivateFile)
      .mockClear()
      .mockImplementationOnce(() => written.promise);
    const first = clients[0]!.authorize();
    const second = clients[0]!.authorize();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    answer.resolve(true);
    await vi.waitFor(() => expect(setupStore.writePrivateFile).toHaveBeenCalledOnce());
    const failure = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    const refused = expect(first).rejects.toBe(failure);
    written.reject(failure);
    await refused;
    expect(await second).toBe(false);
    expect(prepareAccess).not.toHaveBeenCalled();
    expect(access.state(origin)?.allowed).toBe(false);
  });

  it.each(["disable", "revoke"] as const)(
    "does not start setup after %s while saving allowed consent",
    async (action) => {
      const saved = deferred<void>();
      const prepareAccess = vi.fn(async () => undefined);
      const { access, clients } = setup({ prepareAccess });
      await access.select(origin);
      await access.pair();
      vi.mocked(setupStore.writePrivateFile)
        .mockClear()
        .mockImplementationOnce(() => saved.promise);
      const turningOn = access.setAllowed(origin, true);
      await vi.waitFor(() => expect(setupStore.writePrivateFile).toHaveBeenCalledOnce());
      const turningOff =
        action === "disable" ? access.setAllowed(origin, false) : clients[0]!.revoke();
      saved.resolve();
      await turningOn;
      await turningOff;
      expect(prepareAccess).not.toHaveBeenCalled();
      expect(access.state(origin)?.allowed).toBe(false);
      await vi.waitFor(async () =>
        expect(await readDeviceConsent(userData, origin)).toMatchObject({ consent: "declined" }),
      );
    },
  );

  it("runs commands while setup is open, and invalidates setup when access is revoked", async () => {
    const ready = deferred<void>();
    const prepareAccess = vi.fn((_valid: () => boolean) => ready.promise);
    const { access, clients } = setup({ prepareAccess });
    await access.select(origin);
    await access.pair();
    expect(await clients[0]!.authorize()).toBe(true);
    expect(prepareAccess).toHaveBeenCalledOnce();
    const valid = prepareAccess.mock.calls[0]![0];
    expect(valid()).toBe(true);
    await access.setAllowed(origin, false);
    expect(valid()).toBe(false);
    ready.resolve();
    await prepareAccess.mock.results[0]!.value;
    expect(await clients[0]!.authorize()).toBe(false);
  });

  it("asks once on the first request, keeps the answer, and lets waiting requests share it", async () => {
    const answer = deferred<boolean>();
    const confirm = vi.fn(() => answer.promise);
    const { access, clients } = setup({ confirm });
    await access.select(origin);
    await access.pair();
    const first = clients[0]!.authorize();
    const second = clients[0]!.authorize();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith("rakazo.example.com");
    answer.resolve(true);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(await clients[0]!.authorize()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(access.state(origin)?.allowed).toBe(true);
    expect(await readDeviceConsent(userData, origin)).toMatchObject({ consent: "allowed" });

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
    expect(await readDeviceConsent(userData, origin)).toMatchObject({ consent: "declined" });

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
    await saveDeviceConsent(userData, origin, { consent: "allowed", userId: null });
    const { access, clients } = setup();
    await access.select(origin);
    await access.pair();
    await access.setAllowed(origin, false);
    expect(clients).toMatchObject([{ closed: false, cancelled: 1 }]);
    expect(await clients[0]!.authorize()).toBe(false);
  });

  it("refuses new commands immediately while saving a disabled choice", async () => {
    const { access, clients } = setup();
    await access.select(origin);
    await access.pair();
    await access.setAllowed(origin, true);
    const saved = deferred<void>();
    vi.mocked(setupStore.writePrivateFile)
      .mockClear()
      .mockImplementationOnce(() => saved.promise);
    const turningOff = access.setAllowed(origin, false);
    await vi.waitFor(() => expect(setupStore.writePrivateFile).toHaveBeenCalledOnce());
    expect(await clients[0]!.authorize()).toBe(false);
    saved.resolve();
    await turningOff;
  });

  it("stops work and stays off when saving the choice fails", async () => {
    await saveDeviceConsent(userData, origin, { consent: "allowed", userId: null });
    const { access, clients } = setup();
    await access.select(origin);
    await access.pair();
    const failure = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    vi.mocked(setupStore.writePrivateFile).mockRejectedValueOnce(failure);
    await expect(access.setAllowed(origin, false)).rejects.toBe(failure);
    expect(clients).toMatchObject([{ cancelled: 1 }]);
    expect(await clients[0]!.authorize()).toBe(false);
    expect(await readDeviceConsent(userData, origin)).toBeNull();

    await access.select(other);
    await access.select(origin);
    expect(await clients.at(-1)!.authorize()).toBe(false);
    expect(access.state(origin)?.allowed).toBe(false);
  });

  it("ignores a prompt answered after access was turned off or revoked", async () => {
    let answer!: Deferred<boolean>;
    const confirm = vi.fn(() => {
      answer = deferred<boolean>();
      return answer.promise;
    });
    const { access, clients, requests } = setup({ confirm });
    await access.select(origin);
    await access.pair();
    const waiting = clients[0]!.authorize();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await access.setAllowed(origin, false);
    answer.resolve(true);
    expect(await waiting).toBe(false);
    expect(await readDeviceConsent(userData, origin)).toMatchObject({ consent: "declined" });

    const turningOn = access.setAllowed(origin, true);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    clients[0]!.revoke();
    answer.resolve(true);
    await turningOn;
    expect(await readDeviceConsent(userData, origin)).toBeNull();
    expect(access.state(origin)).toEqual({ deviceId: null, allowed: false });
    expect(requests.filter(({ url }) => url.endsWith("/pair"))).toHaveLength(1);
  });

  it("fails turning on and stays off when pairing fails", async () => {
    await saveDeviceConsent(userData, origin, { consent: "declined", userId: null });
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
    expect(await readDeviceConsent(userData, origin)).toBeNull();
    status = 200;
    await access.setAllowed(origin, true);
    expect(access.state(origin)).toEqual({ deviceId: "device-1", allowed: true });
    expect(clients).toHaveLength(1);
  });

  it("keeps access off when it is turned off while pairing", async () => {
    await saveDeviceConsent(userData, origin, { consent: "declined", userId: null });
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
    expect(await readDeviceConsent(userData, origin)).toMatchObject({ consent: "declined" });
    expect(access.state(origin)?.allowed).toBe(false);
  });

  it("ignores a page asking for a server it no longer shows", async () => {
    const confirm = vi.fn(async () => true);
    let respond = () => {};
    const started = deferred();
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = () => resolve(Response.json({ deviceId: "device-1", token: "device-token" }));
          started.resolve();
        }),
    );
    const { access, clients } = setup({ confirm, fetch });
    await access.select(origin);
    const pairing = access.pair();
    await started.promise;
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
      userId: null,
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

    vi.useFakeTimers({ toFake: ["Date"] });
    const refused = setup({ fetch });
    for (const refusal of [400, 403, 404, 405, 409, 413, 415, 422, 426]) {
      status = refusal;
      const target = `https://refused-${refusal}.example.com`;
      await refused.access.select(target);
      await refused.access.pair();
      // Past any retry delay, so only a remembered refusal keeps the second load from asking.
      vi.setSystemTime(Date.now() + MAX_RETRY_AFTER_MS + 1);
      await refused.access.pair();
      expect(fetch.mock.calls.filter(([url]) => url.startsWith(target))).toHaveLength(1);
    }
  });

  it("retries a pairing the server could not answer on a later page load", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const failure of [503, 502, 500, 429, 408, "network"] as const) {
      let failing = true;
      const fetch = vi.fn(async (url: string) => {
        if (!url.endsWith("/api/devices/pair")) return new Response(null, { status: 204 });
        if (failing && failure === "network") throw new Error("offline");
        return failing
          ? new Response(null, { status: failure as number })
          : Response.json({ deviceId: "device-1", token: "device-token" });
      });
      const { access, clients } = setup({ fetch });
      await access.select(`https://retry-${failure}.example.com`);
      await access.pair();
      await access.pair();
      expect(clients).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(1);
      failing = false;
      vi.advanceTimersByTime(5_000);
      await access.pair();
      expect(clients).toHaveLength(1);
    }
  });

  it("reuses a random request key after a lost pairing response", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const tokens: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/api/devices/pair")) return new Response(null, { status: 204 });
      const { pairingKey } = JSON.parse(init!.body as string);
      tokens.push(pairingKey);
      if (tokens.length < 3) throw new Error("response lost");
      return Response.json({ deviceId: "device-1", token: "server-token" });
    });
    const { access, clients } = setup({ fetch });
    await access.select(other);
    await access.pair();
    vi.advanceTimersByTime(5_000);
    await access.pair();
    vi.advanceTimersByTime(5_000);
    await access.pair();
    expect(tokens.length).toBeGreaterThanOrEqual(3);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(clients).toHaveLength(1);
  });

  it("starts a fresh pairing after the server refuses recovery by another sign-in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const keys: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/api/devices/pair")) return new Response(null, { status: 204 });
      keys.push(JSON.parse(init!.body as string).pairingKey);
      if (keys.length === 1) throw new Error("response lost");
      if (keys.length === 2) return new Response(null, { status: 401 });
      return Response.json({ deviceId: "device-1", token: "server-token" });
    });
    const { access, clients } = setup({ fetch });
    await access.select(other);
    await access.pair();
    vi.advanceTimersByTime(5_000);
    await access.pair();
    await access.pair();
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(clients).toHaveLength(1);
  });

  it.each([429, 503])("honors Retry-After after %i without scheduling requests", async (status) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetch = vi.fn(async () =>
      fetch.mock.calls.length === 1
        ? new Response(null, { status, headers: { "retry-after": "60" } })
        : Response.json({ deviceId: "device-1", token: "server-token" }),
    );
    const { access, clients } = setup({ fetch });
    await access.select(other);
    await access.pair();
    await access.pair();
    vi.advanceTimersByTime(59_999);
    await access.pair();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await access.pair();
    expect(clients).toHaveLength(1);
  });

  it("sends a fresh request when computer access is turned on during the retry delay", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetch = vi.fn(async () =>
      fetch.mock.calls.length === 1
        ? new Response(null, { status: 503, headers: { "retry-after": "60" } })
        : Response.json({ deviceId: "device-1", token: "server-token" }),
    );
    const { access, clients } = setup({ fetch });
    await access.select(other);
    await access.pair();
    expect(fetch).toHaveBeenCalledTimes(1);
    await access.setAllowed(other, true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(clients).toHaveLength(1);
  });

  it("never pairs without secure storage", async () => {
    const { access, requests } = setup({ cipher: { ...cipher, available: async () => false } });
    await access.select(origin);
    await access.pair();
    expect(requests).toEqual([]);
  });

  it("reconnects on launch, disconnects when switching servers, and stops on close", async () => {
    await savePairedDevice(
      userData,
      origin,
      { token: "saved-token", deviceId: "d1", userId: null },
      cipher,
    );
    await saveDeviceConsent(userData, other, { consent: "declined", userId: null });
    const { access, clients, requests } = setup();
    await access.select(origin);
    expect(clients).toMatchObject([{ origin, token: "saved-token", closed: false }]);
    await access.select(other);
    await access.pair();
    expect(clients[0]!.closed).toBe(true);
    expect(clients).toHaveLength(1);
    expect(requests.map((request) => request.url)).toEqual([`${origin}/api/devices/self/session`]);
    await access.select(origin);
    expect(clients).toHaveLength(2);
    access.close();
    expect(clients[1]!.closed).toBe(true);
  });

  it("ties a saved pairing to the sign-in once, retrying until the server ties it", async () => {
    await savePairedDevice(
      userData,
      origin,
      { token: "saved-token", deviceId: "d1", userId: null },
      cipher,
    );
    const statuses = [401, 403, 500];
    const release = deferred();
    const { access, requests } = setup({
      fetch: async (url, init) => {
        requests.push({ url, init });
        // The first request is still out when the window signs in.
        if (requests.length === 1) await release.promise;
        return new Response(null, { status: statuses.shift() ?? 204 });
      },
    });
    await access.select(origin);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      url: `${origin}/api/devices/self/session`,
      init: {
        method: "POST",
        credentials: "include",
        headers: { authorization: "Bearer saved-token" },
      },
    });
    await access.pair();
    release.resolve();
    await vi.waitFor(() => expect(requests).toHaveLength(2));

    await access.pair();
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    await access.pair();
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    // The fake fetch does no I/O, so every pending promise settles before setImmediate runs.
    await new Promise(setImmediate);
    await access.pair();
    await new Promise(setImmediate);
    expect(requests).toHaveLength(4);
  });

  it("forgets a revoked token and stays unpaired until turned back on", async () => {
    await savePairedDevice(
      userData,
      origin,
      { token: "saved-token", deviceId: "d1", userId: null },
      cipher,
    );
    await saveDeviceConsent(userData, origin, { consent: "allowed", userId: null });
    const confirm = vi.fn(async () => true);
    const { access, clients, requests } = setup({ confirm });
    await access.select(origin);
    clients[0]!.revoke();
    await vi.waitFor(async () =>
      expect(await readPairedDevice(userData, origin, cipher)).toBeNull(),
    );
    await vi.waitFor(async () =>
      expect(await readDeviceConsent(userData, origin)).toMatchObject({ consent: "declined" }),
    );
    expect(access.state(origin)).toEqual({ deviceId: null, allowed: false });
    await access.pair();
    expect(requests.map((request) => request.url)).toEqual([`${origin}/api/devices/self/session`]);

    await access.setAllowed(origin, true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(access.state(origin)).toEqual({ deviceId: "device-1", allowed: true });
    expect(clients.at(-1)).toMatchObject({ token: "device-token", closed: false });
  });
  /** A server that pairs whoever the window is signed in as. */
  function accountServer() {
    const server = { account: null as string | null, paired: 0 };
    const fetch = vi.fn(async (url: string) => {
      if (!url.endsWith("/api/devices/pair")) return new Response(null, { status: 204 });
      if (server.account === null) return new Response(null, { status: 401 });
      server.paired += 1;
      return Response.json({
        deviceId: `device-${server.paired}`,
        token: `token-${server.paired}`,
        userId: server.account,
      });
    });
    return { server, fetch };
  }

  it("keeps access for an account that signs out and back in, without asking again", async () => {
    const { server, fetch } = accountServer();
    const confirm = vi.fn(async () => true);
    const { access, clients } = setup({ fetch, confirm });
    server.account = "alice";
    await access.select(origin);
    await access.pair();
    expect(await clients[0]!.authorize()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);

    server.account = null;
    clients[0]!.revoke("session-ended");
    await vi.waitFor(async () =>
      expect(await readPairedDevice(userData, origin, cipher)).toBeNull(),
    );
    expect(access.state(origin)).toEqual({ deviceId: null, allowed: false });
    await access.pair();
    expect(clients).toHaveLength(1);

    server.account = "alice";
    await access.pair();
    expect(clients.at(-1)).toMatchObject({ token: "token-2", closed: false });
    expect(access.state(origin)).toEqual({ deviceId: "device-2", allowed: true });
    expect(await clients.at(-1)!.authorize()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await readDeviceConsent(userData, origin)).toEqual({
      consent: "allowed",
      userId: "alice",
    });
  });

  it("never hands one account's access to the next person who signs in", async () => {
    const { server, fetch } = accountServer();
    const confirm = vi.fn(async () => true);
    const { access, clients } = setup({ fetch, confirm });
    server.account = "alice";
    await access.select(origin);
    await access.setAllowed(origin, true);
    expect(access.state(origin)).toEqual({ deviceId: "device-1", allowed: true });

    server.account = null;
    clients[0]!.revoke("session-ended");
    server.account = "bob";
    await access.pair();
    expect(clients.at(-1)).toMatchObject({ token: "token-2", closed: false });
    expect(access.state(origin)).toEqual({ deviceId: "device-2", allowed: false });

    confirm.mockResolvedValueOnce(false);
    expect(await clients.at(-1)!.authorize()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("ignores a prompt from a sign-in that ended before it was answered", async () => {
    const { server, fetch } = accountServer();
    let answer!: Deferred<boolean>;
    const confirm = vi.fn(() => {
      answer = deferred<boolean>();
      return answer.promise;
    });
    const { access, clients } = setup({ fetch, confirm });
    server.account = "alice";
    await access.select(origin);
    await access.pair();
    const waiting = clients[0]!.authorize();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));

    server.account = null;
    clients[0]!.revoke("session-ended");
    server.account = "bob";
    await access.pair();
    answer.resolve(true);
    expect(await waiting).toBe(false);
    expect(access.state(origin)).toEqual({ deviceId: "device-2", allowed: false });
    expect(await readDeviceConsent(userData, origin)).toBeNull();
  });

  it("pairs the next account even when its page loaded before the old pairing ended", async () => {
    const { server, fetch } = accountServer();
    const { access, clients } = setup({ fetch });
    server.account = "alice";
    await access.select(origin);
    await access.pair();

    server.account = "bob";
    await access.pair();
    expect(clients).toHaveLength(1);
    clients[0]!.revoke("session-ended");
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    expect(clients[1]).toMatchObject({ token: "token-2", closed: false });
    expect(access.state(origin)).toEqual({ deviceId: "device-2", allowed: false });
  });

  it("does not let a saved answer for another account through after a relaunch", async () => {
    await savePairedDevice(
      userData,
      origin,
      { token: "saved-token", deviceId: "d1", userId: "bob" },
      cipher,
    );
    await saveDeviceConsent(userData, origin, { consent: "allowed", userId: "alice" });
    const confirm = vi.fn(async () => false);
    const { access, clients } = setup({ confirm });
    await access.select(origin);
    expect(access.state(origin)).toEqual({ deviceId: "d1", allowed: false });
    expect(await clients[0]!.authorize()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
