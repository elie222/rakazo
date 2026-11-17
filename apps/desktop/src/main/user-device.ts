import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import type { UserDeviceClientOptions } from "@rakazo/adapters/user-device-client";
import type {
  RakazoDesktopDevice,
  UserDevicePairRequest,
  UserDevicePairResponse,
} from "@rakazo/contracts";
import {
  USER_DEVICE_PAIR_PATH,
  USER_DEVICE_PATH,
  USER_DEVICE_SESSION_PATH,
} from "@rakazo/contracts";
import { secureHttpOrigin } from "@rakazo/contracts/network-host";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export interface DeviceTokenCipher {
  available(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}

const MAX_DEVICE_FILE_BYTES = 8 * 1024;
const MAX_TOKEN_LENGTH = 1024;

export interface PairedDevice {
  token: string;
  deviceId: string | null;
  /** The account it was paired for; null when paired before the server reported it. */
  userId: string | null;
}

/** Only the native prompt sets "allowed". */
export type DeviceConsent = "allowed" | "declined";

/** "allowed" holds only for the account it was given for. */
export interface SavedConsent {
  consent: DeviceConsent;
  userId: string | null;
}

const optionalString = (value: unknown) => (typeof value === "string" ? value : null);

function deviceFile(userDataDir: string, origin: string, suffix = "") {
  const key = createHash("sha256").update(origin).digest("hex").slice(0, 32);
  return path.join(userDataDir, "devices", `${key}${suffix}.json`);
}

export async function readPairedDevice(
  userDataDir: string,
  origin: string,
  cipher: DeviceTokenCipher,
): Promise<PairedDevice | null> {
  const raw = await readPrivateFile(deviceFile(userDataDir, origin), MAX_DEVICE_FILE_BYTES);
  if (raw === null) return null;
  try {
    const saved = JSON.parse(raw);
    if (saved?.origin !== origin || typeof saved.token !== "string") return null;
    const token = await cipher.decrypt(Buffer.from(saved.token, "base64"));
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
    return {
      token,
      deviceId: optionalString(saved.deviceId),
      userId: optionalString(saved.userId),
    };
  } catch {
    return null;
  }
}

export async function savePairedDevice(
  userDataDir: string,
  origin: string,
  device: PairedDevice,
  cipher: DeviceTokenCipher,
): Promise<void> {
  if (!(await cipher.available())) throw new Error("Secure storage is unavailable");
  const file = deviceFile(userDataDir, origin);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = (await cipher.encrypt(device.token)).toString("base64");
  await writePrivateFile(
    file,
    JSON.stringify({ origin, token, deviceId: device.deviceId, userId: device.userId }),
  );
}

export async function deletePairedDevice(userDataDir: string, origin: string): Promise<void> {
  await rm(deviceFile(userDataDir, origin), { force: true });
}

export async function readDeviceConsent(
  userDataDir: string,
  origin: string,
): Promise<SavedConsent | null> {
  const raw = await readPrivateFile(
    deviceFile(userDataDir, origin, ".consent"),
    MAX_DEVICE_FILE_BYTES,
  );
  try {
    const saved = raw === null ? null : JSON.parse(raw);
    if (saved?.origin !== origin) return null;
    // Versions before accounts were saved also wrote "declined" when the server ended a pairing,
    // so that answer may not be the person's: ask again.
    if (saved.consent === "declined" && !("userId" in saved)) return null;
    return saved.consent === "allowed" || saved.consent === "declined"
      ? { consent: saved.consent, userId: optionalString(saved.userId) }
      : null;
  } catch {
    return null;
  }
}

export async function saveDeviceConsent(
  userDataDir: string,
  origin: string,
  { consent, userId }: SavedConsent,
): Promise<void> {
  const file = deviceFile(userDataDir, origin, ".consent");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writePrivateFile(file, JSON.stringify({ origin, consent, userId }));
}

export async function deviceName(platform = process.platform): Promise<string> {
  const fallback = hostname().replace(/\.local$/, "") || "Computer";
  if (platform !== "darwin") return fallback.slice(0, 128);
  const friendly = await new Promise<string>((resolve) => {
    execFile("/usr/sbin/scutil", ["--get", "ComputerName"], { timeout: 2_000 }, (error, stdout) =>
      resolve(error ? "" : stdout.trim()),
    );
  });
  return (friendly || fallback).slice(0, 128);
}

/**
 * Connects this computer to the remote server the app shows. Pairing and connecting grant
 * nothing: every request waits for this computer's consent for that server, which only the
 * native prompt gives. The token and the consent stay in the main process and app-private storage.
 */
export function createUserDeviceAccess(deps: {
  userDataDir: string;
  cipher: DeviceTokenCipher;
  device: () => Promise<UserDevicePairRequest>;
  /** The native consent prompt. Resolves true only when the person clicks Allow. */
  confirm: (host: string) => Promise<boolean>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  connect: (
    origin: string,
    token: string,
    events: {
      onRevoked: UserDeviceClientOptions["onRevoked"];
      authorize: () => Promise<boolean>;
    },
  ) => { close(): void; cancelAll(): void };
}) {
  let current: string | null = null;
  let generation = 0;
  let client: { origin: string; close(): void; cancelAll(): void } | undefined;
  const paired = new Map<string, Omit<PairedDevice, "token">>();
  const consent = new Map<string, SavedConsent | null>();
  /** Bumped on every consent change, so a prompt answered after one is ignored. */
  const changes = new Map<string, number>();
  const consentSaves = new Map<string, Promise<void>>();
  const unavailable = new Set<string>();
  const prompts = new Map<string, Promise<boolean>>();
  const pairings = new Map<string, Promise<void>>();
  /** Saved tokens not yet tied to a sign-in this launch; pairings from before that was recorded. */
  const untied = new Map<string, string>();
  const tying = new Map<string, { again: boolean }>();
  /** A revoked token's file deletion, which a new pairing's save must follow. */
  const removals = new Map<string, Promise<void>>();

  function disconnect() {
    client?.close();
    client = undefined;
  }

  function start(origin: string, token: string) {
    disconnect();
    const active = {
      origin,
      close: () => connection.close(),
      cancelAll: () => connection.cancelAll(),
    };
    const connection = deps.connect(origin, token, {
      onRevoked: (reason) => {
        if (client === active) client = undefined;
        paired.delete(origin);
        untied.delete(origin);
        removals.set(
          origin,
          deletePairedDevice(deps.userDataDir, origin).catch(() => undefined),
        );
        // Signing out ends the pairing but keeps the answer for that account's next sign-in;
        // a prompt still open belongs to the ended sign-in. Removed or rejected otherwise:
        // stay unpaired until turned back on.
        if (reason !== "session-ended") {
          void decide(origin, "declined").catch(() => undefined);
          return;
        }
        changes.set(origin, (changes.get(origin) ?? 0) + 1);
        // Whoever signed in next may have loaded the page before this arrived.
        if (current === origin) void pair();
      },
      authorize: () => authorize(origin),
    });
    client = active;
  }

  function isAllowed(origin: string) {
    const choice = consent.get(origin);
    const device = paired.get(origin);
    return choice?.consent === "allowed" && device !== undefined && choice.userId === device.userId;
  }

  async function decide(origin: string, choice: DeviceConsent) {
    const saved = { consent: choice, userId: paired.get(origin)?.userId ?? null };
    consent.set(origin, saved);
    changes.set(origin, (changes.get(origin) ?? 0) + 1);
    const save = (consentSaves.get(origin) ?? Promise.resolve()).then(() =>
      saveDeviceConsent(deps.userDataDir, origin, saved).catch(async (error) => {
        // An earlier "allowed" left on disk would be honoured on the next launch.
        if (choice === "declined")
          await rm(deviceFile(deps.userDataDir, origin, ".consent"), { force: true }).catch(
            () => undefined,
          );
        throw error;
      }),
    );
    consentSaves.set(
      origin,
      save.catch(() => undefined),
    );
    await save;
  }

  function ask(origin: string) {
    let prompt = prompts.get(origin);
    if (!prompt) {
      prompt = deps
        .confirm(new URL(origin).host)
        .catch(() => false)
        .finally(() => prompts.delete(origin));
      prompts.set(origin, prompt);
    }
    return prompt;
  }

  async function authorize(origin: string) {
    if (consent.get(origin)?.consent === "declined") return false;
    if (isAllowed(origin)) return true;
    const seen = changes.get(origin);
    const answer = await ask(origin);
    // Turned off, revoked, or already answered while the prompt was open.
    if (changes.get(origin) !== seen) return isAllowed(origin);
    await decide(origin, answer ? "allowed" : "declined").catch(() => undefined);
    return answer;
  }

  function pair() {
    const origin = current;
    if (origin === null) return Promise.resolve();
    void tieToSignIn(origin);
    if (consent.get(origin)?.consent === "declined") return Promise.resolve();
    return pairOnce(origin);
  }

  /**
   * Retries on each sign-in until the server ties it; already tied, the server leaves it alone.
   * A sign-in during a request asks again once that request ends.
   */
  async function tieToSignIn(origin: string) {
    const running = tying.get(origin);
    if (running) {
      running.again = true;
      return;
    }
    const state = { again: false };
    tying.set(origin, state);
    try {
      for (;;) {
        const token = untied.get(origin);
        if (!token) return;
        state.again = false;
        if (await requestTie(origin, token)) {
          if (untied.get(origin) === token) untied.delete(origin);
          return;
        }
        if (!state.again) return;
      }
    } finally {
      tying.delete(origin);
    }
  }

  async function requestTie(origin: string, token: string) {
    try {
      const response = await deps.fetch(new URL(USER_DEVICE_SESSION_PATH, origin).href, {
        method: "POST",
        credentials: "include",
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      return response.status === 204;
    } catch {
      return false;
    }
  }

  function pairOnce(origin: string) {
    if (paired.has(origin) || unavailable.has(origin)) return Promise.resolve();
    let pairing = pairings.get(origin);
    if (!pairing) {
      pairing = pairWith(origin).finally(() => pairings.delete(origin));
      pairings.set(origin, pairing);
    }
    return pairing;
  }

  async function pairWith(origin: string) {
    if (!(await deps.cipher.available())) {
      unavailable.add(origin);
      return;
    }
    let device: PairedDevice;
    try {
      const response = await deps.fetch(new URL(USER_DEVICE_PAIR_PATH, origin).href, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(await deps.device()),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Signed out: the next page load after sign-in tries again.
        if (response.status !== 401) unavailable.add(origin);
        return;
      }
      const body = (await response.json()) as Partial<
        Record<keyof UserDevicePairResponse, unknown>
      >;
      if (
        typeof body?.token !== "string" ||
        body.token.length === 0 ||
        body.token.length > MAX_TOKEN_LENGTH ||
        typeof body.deviceId !== "string"
      ) {
        unavailable.add(origin);
        return;
      }
      device = { token: body.token, deviceId: body.deviceId, userId: optionalString(body.userId) };
    } catch {
      return;
    }
    try {
      await removals.get(origin);
      await savePairedDevice(deps.userDataDir, origin, device, deps.cipher);
    } catch {
      // A token that cannot be kept must not stay valid on the server.
      await revokeToken(origin, device.token);
      unavailable.add(origin);
      return;
    }
    paired.set(origin, { deviceId: device.deviceId, userId: device.userId });
    if (current === origin) start(origin, device.token);
  }

  async function revokeToken(origin: string, token: string) {
    try {
      const response = await deps.fetch(new URL(`${USER_DEVICE_PATH}/self`, origin).href, {
        method: "DELETE",
        credentials: "omit",
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
    } catch {
      /* The local token is deleted regardless. */
    }
  }

  return {
    /** Switches to a server origin (or none), connecting or pairing unless this computer declined it. */
    async select(origin: string | null) {
      origin = secureHttpOrigin(origin ?? undefined);
      if (origin === current) return;
      const selection = ++generation;
      disconnect();
      current = origin;
      if (origin === null) return;
      const [device, choice] = await Promise.all([
        readPairedDevice(deps.userDataDir, origin, deps.cipher),
        readDeviceConsent(deps.userDataDir, origin),
      ]);
      if (selection !== generation) return;
      if (consent.get(origin)?.consent !== "declined") consent.set(origin, choice);
      if (device) {
        paired.set(origin, { deviceId: device.deviceId, userId: device.userId });
        untied.set(origin, device.token);
        start(origin, device.token);
        void tieToSignIn(origin);
      } else {
        paired.delete(origin);
        void pair();
      }
    },
    /** Pairs the current server when it is not paired yet, e.g. once the person signs in. */
    pair,
    state(origin: string): Omit<RakazoDesktopDevice, "name"> | null {
      if (origin !== current) return null;
      return { deviceId: paired.get(origin)?.deviceId ?? null, allowed: isAllowed(origin) };
    },
    /**
     * Turning it on asks with the native prompt and keeps the answer only once this computer is
     * paired; turning it off stops every running and waiting request.
     */
    async setAllowed(origin: string, allowed: boolean) {
      if (origin !== current) return;
      if (!allowed) {
        const saving = decide(origin, "declined");
        if (client?.origin === origin) client.cancelAll();
        await saving;
        return;
      }
      const seen = changes.get(origin);
      if (!isAllowed(origin) && !(await ask(origin))) return;
      if (changes.get(origin) !== seen && consent.get(origin)?.consent !== "allowed") return;
      unavailable.delete(origin);
      await pairOnce(origin);
      if (!paired.has(origin)) throw new Error("Could not pair this computer");
      if (changes.get(origin) !== seen) return;
      await decide(origin, "allowed");
    },
    close() {
      ++generation;
      current = null;
      disconnect();
    },
  };
}

export type UserDeviceAccess = ReturnType<typeof createUserDeviceAccess>;
