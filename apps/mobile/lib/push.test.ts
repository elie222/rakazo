import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-constants", () => ({ default: { easConfig: { projectId: "fake-project" } } }));

// Expo runs every module's async functions on one serial native queue, so a call
// that waits there holds up SecureStore too.
const native = vi.hoisted(() => {
  let queue: Promise<unknown> = Promise.resolve();
  const run = <T>(work: () => T | Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };
  const store = new Map<string, string>();
  return {
    run,
    store,
    reset() {
      queue = Promise.resolve();
      store.clear();
    },
  };
});

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn((key: string) => native.run(() => native.store.get(key) ?? null)),
  setItemAsync: vi.fn((key: string, value: string) =>
    native.run(() => void native.store.set(key, value)),
  ),
  deleteItemAsync: vi.fn((key: string) => native.run(() => void native.store.delete(key))),
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(async () => ({ data: "ExponentPushToken[fake]" })),
}));

import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { currentApiBase, rpc, selectInitialSpace, signOut } from "./api";
import {
  pendingSessionTokens,
  queueSessionRevocation,
  retryPendingSessionRevocations,
} from "./pending-session-revocations";
import { registerPushToken } from "./push";
import { rememberSavedAccount } from "./saved-accounts";
import { restoreSessionToken } from "./session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settled = <T>(promise: Promise<T>) =>
  Promise.race([promise, new Promise((done) => setTimeout(done, 100, "still waiting"))]);

const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
  const json = url.endsWith("/rpc/me")
    ? { userId: "user-1", spaceId: "space-1" }
    : url.endsWith("/rpc/spaces/list")
      ? { current: { id: "space-1", bots: [{ id: "bot-1" }] }, spaces: [] }
      : {};
  return new Response(JSON.stringify({ json }), { status: 200 });
});

let permission: ReturnType<typeof deferred<{ granted: boolean }>>;

beforeEach(async () => {
  native.reset();
  vi.stubGlobal("fetch", fetch);
  fetch.mockClear();
  vi.mocked(Notifications.requestPermissionsAsync).mockClear();
  permission = deferred();
  // iOS answers both from the system's notification settings, which can take minutes
  // after a restart. Reading them waits on the native queue; the request does not.
  vi.mocked(Notifications.getPermissionsAsync).mockImplementation(() =>
    native.run(() => new Promise(() => {})),
  );
  vi.mocked(Notifications.requestPermissionsAsync).mockImplementation(
    () => native.run(() => undefined).then(() => permission.promise) as never,
  );
  await restoreSessionToken("fake-session");
});

afterEach(() => {
  Platform.OS = "ios";
  vi.unstubAllGlobals();
});

describe("push registration on iOS", () => {
  it("loads the inbox while notification settings have not answered", async () => {
    void registerPushToken();

    // The inbox's first load: the space list and account, then the default space.
    const loaded = Promise.all([rpc("spaces/list"), rpc("me")]).then(async ([, me]) =>
      selectInitialSpace(me.spaceId),
    );

    await expect(settled(loaded)).resolves.toBe(true);
  });

  it("registers the token once permission is granted", async () => {
    void registerPushToken();
    await settled(Promise.resolve());
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringMatching(/notifications\/registerPush$/),
      expect.anything(),
    );

    permission.resolve({ granted: true });

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringMatching(/notifications\/registerPush$/),
        expect.objectContaining({
          body: JSON.stringify({ json: { token: "ExponentPushToken[fake]" } }),
        }),
      ),
    );
  });
});

describe("push registration on Android", () => {
  it("does not ask again once notifications are allowed", async () => {
    Platform.OS = "android";
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);

    await registerPushToken();

    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/notifications\/registerPush$/),
      expect.anything(),
    );
  });
});

it("registers one device token independently for every saved signed-in account", async () => {
  for (const userId of ["family", "work"])
    await rememberSavedAccount(currentApiBase(), {
      userId,
      token: `${userId}-token`,
      email: `${userId}@example.test`,
    });
  await restoreSessionToken("family-token");
  permission.resolve({ granted: true });
  await registerPushToken();
  const registrations = fetch.mock.calls.filter(([url]) =>
    url.endsWith("/rpc/notifications/registerPush"),
  );
  expect(registrations).toHaveLength(2);
  expect(
    registrations
      .map(([, init]) => (init as RequestInit).headers)
      .map((headers) => (headers as Record<string, string>).authorization)
      .sort(),
  ).toEqual(["Bearer family-token", "Bearer work-token"]);
});

it("does not register a locally signed-out credential while its revocation retry is failing", async () => {
  await queueSessionRevocation(currentApiBase(), "fake-session");
  // The fixture's generic successful HTTP reply is not an acknowledged auth sign-out.
  permission.resolve({ granted: true });
  await registerPushToken();
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/api/auth/sign-out"))).toBe(true);
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/notifications/registerPush"))).toBe(false);
});

it.each([false, true])(
  "cleans up a registration after local sign-out, retaining retries when cleanup is offline (%s)",
  async (cleanupOffline) => {
    const apiBase = currentApiBase();
    for (const userId of ["family", "work"]) {
      await rememberSavedAccount(apiBase, {
        userId,
        token: `${userId}-token`,
        email: `${userId}@example.test`,
      });
    }
    await restoreSessionToken("family-token");
    const started = deferred<void>();
    const late = deferred<void>();
    const bindings = new Set(["family-token", "work-token"]);
    const unregisters: string[] = [];
    let offline = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const credential = (new Headers(init?.headers).get("authorization") ?? "").replace(
          /^Bearer /,
          "",
        );
        if (url.endsWith("/notifications/registerPush")) {
          if (credential === "family-token") {
            started.resolve();
            await late.promise;
          }
          bindings.add(credential);
        }
        if (url.endsWith("/notifications/unregisterPush")) {
          unregisters.push(credential);
          if (cleanupOffline && unregisters.length > 1) throw new Error("offline cleanup");
          bindings.delete(credential);
        }
        if (url.endsWith("/api/auth/sign-out")) {
          if (offline) throw new Error("offline revocation");
          bindings.delete(credential);
          return Response.json({ success: true });
        }
        return Response.json({ json: {} });
      }),
    );
    permission.resolve({ granted: true });
    const registering = registerPushToken();
    await started.promise;
    await signOut();
    expect(bindings.has("family-token")).toBe(false);
    await restoreSessionToken("work-token");
    late.resolve();
    await registering;
    expect(bindings).toEqual(
      new Set(cleanupOffline ? ["family-token", "work-token"] : ["work-token"]),
    );
    expect(unregisters).toEqual(["family-token", "family-token"]);
    expect(await pendingSessionTokens(apiBase)).toEqual(new Set(["family-token"]));
    offline = false;
    await retryPendingSessionRevocations(apiBase);
    expect(bindings).toEqual(new Set(["work-token"]));
    expect(await pendingSessionTokens(apiBase)).toEqual(new Set());
  },
);
