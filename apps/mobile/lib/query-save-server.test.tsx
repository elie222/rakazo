// @vitest-environment jsdom
vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import { deferred, flush } from "@rakazo/core/test-async";
import * as SecureStore from "expo-secure-store";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentApiBase, setCachedApiBase, setSelectedSpace } from "./api";
import { saveApiBase } from "./api-server";
import { jsonResponse, mockSecureStore } from "./api-test-helpers";
import type { SaveSend } from "./query";
import { useSave } from "./query";
import { restoreSessionToken, saveSessionToken } from "./session";
import type { SettingsTarget } from "./settings-target";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));

const OLD = "https://old.example.test";
const NEW = "https://new.example.test";
const SESSION_KEY = "rakazo.session_token";
const WRITE = "spaceSettings/setOverride";

const onSaved = vi.fn();
const onFailed = vi.fn();
let target: SettingsTarget | undefined;
let screen: ReturnType<typeof useSave<boolean, unknown>>;
function Screen() {
  screen = useSave({
    target,
    save: (enabled: boolean, send: SaveSend) => send(WRITE, { setting: "voice", enabled }),
    onSaved,
    onFailed,
  });
  return null;
}

let store: Map<string, string>;
let requests: { url: string; authorization: string | null; space: string | null }[];
let originalBase: string;
let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSaved.mockReset();
  onFailed.mockReset();
  target = undefined;
  store = new Map();
  mockSecureStore(store);
  originalBase = currentApiBase();
  setCachedApiBase(OLD);
  await restoreSessionToken("old-token");
  setSelectedSpace("space-old");
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("authorization"),
        space: headers.get("x-rakazo-space-id"),
      });
      return jsonResponse({ json: [] });
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  mockSecureStore(store);
  setCachedApiBase(originalBase);
  setSelectedSpace("");
  await restoreSessionToken("");
  vi.unstubAllGlobals();
});

async function settle() {
  await act(flush);
}
const writes = () => requests.filter((request) => request.url.endsWith(`/rpc/${WRITE}`));

/** Holds the next read of the stored session, as while a save waits for its credentials. */
function holdTokenRead(answer: "as read" | "as stored by then") {
  const held = deferred();
  let waiting = true;
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
    if (key !== SESSION_KEY || !waiting) return store.get(key) ?? null;
    waiting = false;
    const read = store.get(key) ?? null;
    await held.promise;
    return answer === "as read" ? read : (store.get(key) ?? null);
  });
  return held.resolve;
}

const targets: [string, SettingsTarget | undefined, string][] = [
  ["the selected space", undefined, "space-old"],
  ["a named Space", { scope: "space", spaceId: "space-named" }, "space-named"],
  ["the account", { scope: "account" }, "space-old"],
];

describe.each(targets)("a save for %s", (_name, saveTarget, space) => {
  beforeEach(async () => {
    target = saveTarget;
    await act(async () => root.render(<Screen />));
  });

  it("writes to the server it was started on, with that server's session", async () => {
    await act(async () => screen.run(true));
    await settle();
    expect(writes()).toEqual([
      { url: `${OLD}/rpc/${WRITE}`, authorization: "Bearer old-token", space },
    ]);
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "is switched and signed in to",
      "as stored by then",
      async () => {
        expect(await saveApiBase(NEW)).toEqual({ ok: true, url: NEW });
        await saveSessionToken("new-token");
      },
    ],
    // No session change comes with it, so only the pinned context can tell the servers apart.
    ["changes", "as read", async () => setCachedApiBase(NEW)],
  ] as const)(
    "sends nothing, and shows nothing, when the server %s while it waits for its credentials",
    async (_change, answer, change) => {
      const release = holdTokenRead(answer);
      await act(async () => screen.run(true));
      expect(screen.pending).toBe(true);
      await act(change);
      await act(async () => root.render(<Screen />));
      await act(async () => release());
      await settle();
      expect(writes()).toEqual([]);
      expect(screen.pending).toBe(false);
      expect(screen.error).toBeNull();
      expect(onSaved).not.toHaveBeenCalled();
      expect(onFailed).not.toHaveBeenCalled();
    },
  );
});
