import { beforeEach, expect, it, vi } from "vitest";

// Storage that outlives a restart: the keychain and the saved outbox.
const store = vi.hoisted(() => new Map<string, string>());
const outbox = vi.hoisted(() => ({ entries: [] as unknown[] }));
const alerts = vi.hoisted(
  () => [] as Array<{ title: string; buttons: Array<{ text: string; onPress?: () => void }> }>,
);

vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    store.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    store.delete(key);
  },
}));
vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, _message: string, buttons: (typeof alerts)[number]["buttons"]) =>
      alerts.push({ title, buttons }),
  },
  AppState: { addEventListener: () => ({ remove() {} }) },
}));
vi.mock("./api", () => ({
  captureApiRequestContext: async () => ({ apiBase: "https://api.example.test", headers: {} }),
  currentApiBase: () => "https://api.example.test",
  isServerReachable: () => false,
  passwordChangeInFlight: () => false,
  rpc: async () => {
    throw new Error("offline");
  },
  selectedSpaceId: () => "space-a",
  subscribeServerReachable: () => () => {},
}));
// Like the server's "me" lookup, the outbox owner needs a session.
vi.mock("./integrations-cache", () => ({
  integrationsCacheScope: async () => {
    if (!store.get("rakazo.session_token")) throw new Error("Unauthorized");
    return { apiBase: "https://api.example.test", userId: "user-a", spaceId: "space-a" };
  },
}));
vi.mock("./outbox-disk", () => ({
  hasSavedUnsentSends: () => outbox.entries.length > 0,
  outboxDisk: {
    admit: () => true,
    hydrate: async () => {},
    forget: () => {},
    save: (attempts: unknown[]) => {
      outbox.entries = [...attempts];
    },
    load: (session: number) => outbox.entries.map((entry) => ({ ...(entry as object), session })),
    clear: () => {
      outbox.entries = [];
    },
  },
}));
vi.mock("./live-notifications", () => ({ stopLiveNotifications: async () => {} }));
vi.mock("./network-cache", () => ({ clearNetworkCache: () => {} }));
vi.mock("./referral", () => ({ forgetReferrals: () => {} }));
vi.mock("./returning-user", () => ({ rememberSignedIn: async () => {} }));
vi.mock("./model-settings", () => ({ askToAddModel: () => {} }));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A message that could not be sent yet, as the outbox saves it. */
function waiting() {
  return {
    clientNonce: "waiting-message",
    state: "queued",
    error: "",
    apiBase: "https://api.example.test",
    userId: "user-a",
    spaceId: "space-a",
    artifactIds: new Map(),
    payload: { originThreadKey: "bot-a", displayText: "Hello", attachments: [] },
  };
}

/** A fresh launch: every module starts over, the keychain and the outbox stay. */
async function launch() {
  vi.resetModules();
  const sends = await import("./unsent-sends");
  const warning = await import("./unsent-send-warning");
  const session = await import("./session");
  const stop = sends.startUnsentSends();
  await settle();
  return { ...warning, ...session, stop };
}

beforeEach(() => {
  store.clear();
  outbox.entries = [];
  alerts.length = 0;
});

it("asks before signing in deletes a rejected session's queue after a restart", async () => {
  store.set("rakazo.session_token", "fake-session-a");
  outbox.entries = [waiting()];
  const first = await launch();
  expect(outbox.entries).toHaveLength(1);
  // The server rejects the session; the queue stays for the sign-in warning.
  await first.clearSessionToken({ keepUnsent: true });
  expect(outbox.entries).toHaveLength(1);
  first.stop();

  const next = await launch();
  const asked = next.confirmUnsentSendLoss("sign-in");
  await vi.waitFor(() => expect(alerts).toHaveLength(1));
  expect(alerts[0]!.title).toBe("Unsent messages");
  alerts[0]!.buttons.find((button) => button.text === "Cancel")!.onPress!();
  await expect(asked).resolves.toBe(false);
  expect(outbox.entries).toHaveLength(1);

  const again = next.confirmUnsentSendLoss("sign-in");
  await vi.waitFor(() => expect(alerts).toHaveLength(2));
  alerts[1]!.buttons.find((button) => button.text === "Sign in anyway")!.onPress!();
  await expect(again).resolves.toBe(true);
  await next.saveSessionToken("fake-session-b");
  expect(outbox.entries).toHaveLength(0);
  next.stop();
});

it("signs in without asking after a restart when nothing waits", async () => {
  const next = await launch();
  await expect(next.confirmUnsentSendLoss("sign-in")).resolves.toBe(true);
  expect(alerts).toHaveLength(0);
  next.stop();
});
