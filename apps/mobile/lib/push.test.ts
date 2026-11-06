import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => true),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-constants", () => ({ default: { easConfig: { projectId: "fake-project" } } }));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: vi.fn(() => null) }));

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

import { requireOptionalNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { rpc } from "./api";
import { signOut } from "./api-auth";
import { selectInitialSpace } from "./api-server";
import { resumeLiveNotifications, stopLiveNotifications } from "./live-notifications.js";
import { registerPushToken } from "./push";
import * as session from "./session";
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

const fetch = vi.fn(async (url: string) => {
  const json = url.endsWith("/rpc/me")
    ? { userId: "user-1", spaceId: "space-1" }
    : url.endsWith("/rpc/spaces/list")
      ? { current: { id: "space-1", bots: [{ id: "bot-1" }] }, spaces: [] }
      : {};
  return new Response(JSON.stringify({ json }), { status: 200 });
});

let permission: ReturnType<typeof deferred<{ granted: boolean }>>;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  native.reset();
  vi.mocked(requireOptionalNativeModule).mockReturnValue(null);
  vi.stubGlobal("fetch", fetch);
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

it("syncs the native session before the server can push", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  const resumed = deferred<boolean>();
  vi.mocked(resumeLiveNotifications).mockReturnValueOnce(resumed.promise);

  const registration = registerPushToken();
  try {
    await vi.waitFor(() =>
      expect(resumeLiveNotifications).toHaveBeenCalledExactlyOnceWith(
        "http://127.0.0.1:3100",
        "fake-session",
        expect.any(String),
      ),
    );
    await expect(settled(registration)).resolves.toBe("still waiting");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    resumed.resolve(true);
    await registration;
  }
  expect(fetch).toHaveBeenCalledWith(
    expect.stringMatching(/notifications\/registerPush$/),
    expect.anything(),
  );
});

it("does not restore a signed-out session while push registration loads its token", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  const loaded = deferred<void>();
  const release = deferred<void>();
  const loadToken = session.loadSessionToken;
  vi.spyOn(session, "loadSessionToken").mockImplementationOnce(async () => {
    const token = await loadToken();
    loaded.resolve();
    await release.promise;
    return token;
  });

  const registration = registerPushToken();
  try {
    await loaded.promise;
    await signOut();
    expect(stopLiveNotifications).toHaveBeenCalledWith(true);
    expect(native.store.has("rakazo.session_token")).toBe(false);
  } finally {
    release.resolve();
    await registration;
  }

  expect(resumeLiveNotifications).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalledWith(
    expect.stringMatching(/notifications\/registerPush$/),
    expect.anything(),
  );
});

it("does not register the push token when the native session sync fails", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  vi.mocked(resumeLiveNotifications).mockRejectedValueOnce(new Error("native sync failed"));

  await registerPushToken();

  // Registering now would have Android drop every push as signed-out; the next
  // registration attempt retries the session sync first.
  expect(fetch).not.toHaveBeenCalledWith(
    expect.stringMatching(/notifications\/registerPush$/),
    expect.anything(),
  );
});

it("does not register push while a sign-in has not saved its token yet", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  vi.spyOn(session, "loadSessionToken").mockResolvedValueOnce("");

  await registerPushToken();

  expect(resumeLiveNotifications).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalledWith(
    expect.stringMatching(/notifications\/registerPush$/),
    expect.anything(),
  );
});

it("registers native sender delivery only when the installed Android module supports it", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  vi.mocked(requireOptionalNativeModule).mockReturnValue({ supportsSenderAvatars: true });
  await registerPushToken();
  const call = fetch.mock.calls.find(([url]) => url.endsWith("/rpc/notifications/registerPush"));
  const options = (call as unknown as [string, RequestInit])[1];
  expect(JSON.parse(String(options.body)).json).toMatchObject({ presentation: "android_sender" });
});

it("registers plain delivery when the native module does not keep the session", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  vi.mocked(requireOptionalNativeModule).mockReturnValue({ supportsSenderAvatars: true });
  // A public http server: native notifications skip it and store no session.
  vi.mocked(resumeLiveNotifications).mockResolvedValueOnce(false);
  await registerPushToken();
  const call = fetch.mock.calls.find(([url]) => url.endsWith("/rpc/notifications/registerPush"));
  const options = (call as unknown as [string, RequestInit])[1];
  // Sender delivery would drop every push as signed out; plain pushes are still shown.
  expect(JSON.parse(String(options.body)).json).not.toHaveProperty("presentation");
});
