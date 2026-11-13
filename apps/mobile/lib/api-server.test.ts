vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authHeaders,
  currentApiBase,
  flushPendingSignOut,
  rpc,
  selectedSpaceId,
  spaceSelectionSeq,
} from "./api.js";
import { signIn, signOut } from "./api-auth.js";
import {
  adoptDeletedSpaceFallback,
  clearSpace,
  configureSessionEndHangUp,
  loadApiBase,
  resetApiBase,
  saveApiBase,
  selectSpace,
} from "./api-server.js";
import { resumeLiveNotifications, stopLiveNotifications } from "./live-notifications.js";
import {
  clearSessionToken,
  restoreSessionToken,
  saveSessionToken,
  snapshotSessionToken,
} from "./session.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

import {
  jsonResponse,
  mockSecureStore,
  pendingSignOutRecords,
  rpcErrorResponse,
} from "./api-test-helpers";

describe("mobile API server and Space selection", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    vi.mocked(resumeLiveNotifications).mockClear();
    await restoreSessionToken("");
  });

  it("shares the selected space with direct API requests", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    await selectSpace("space-support");

    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
  });

  it("does not switch spaces when the selection cannot be persisted", async () => {
    await expect(selectSpace("space-support")).resolves.toBe(true);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
    });

    await expect(selectSpace("space-social")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-support");

    vi.mocked(SecureStore.setItemAsync).mockReset();
    await selectSpace("");
  });

  it("does not switch spaces when stale recovery cannot be cleared", async () => {
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback" && value === "") throw new Error("device locked");
    });

    await expect(selectSpace("space-social")).resolves.toBe(false);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith("rakazo.space_id", "space-social");
    expect(selectedSpaceId()).toBe("space-support");

    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    await selectSpace("");
  });

  it("clears server-specific session and space state when the API endpoint changes", async () => {
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockClear();

    await expect(saveApiBase("https://second-server.example")).resolves.toMatchObject({ ok: true });

    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.session_token");
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.space_id");
    await resetApiBase();
  });

  it("keeps the previous server's revocation pending when switching servers signed in", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);

    await expect(saveApiBase("https://second-server.example")).resolves.toMatchObject({ ok: true });

    // The old server keeps the session and the push registration after a local switch.
    expect(pendingSignOutRecords(store)).toEqual([
      { apiBase: "http://127.0.0.1:3100", token: "session-token" },
    ]);
    await resetApiBase();
  });

  it("records the switch's revocation before discarding the old session", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);

    await expect(saveApiBase("https://second-server.example")).resolves.toMatchObject({ ok: true });

    const recorded = vi
      .mocked(SecureStore.setItemAsync)
      .mock.calls.findIndex(([key]) => key === "rakazo.pending_sign_out");
    const discarded = vi
      .mocked(SecureStore.deleteItemAsync)
      .mock.calls.findIndex((call) => call[0] === "rakazo.session_token");
    expect(recorded).toBeGreaterThanOrEqual(0);
    expect(discarded).toBeGreaterThanOrEqual(0);
    // A process kill between the two leaves the revocation durable, not neither.
    const recordedOrder = vi.mocked(SecureStore.setItemAsync).mock.invocationCallOrder[
      recorded
    ] as number;
    const discardedOrder = vi.mocked(SecureStore.deleteItemAsync).mock.invocationCallOrder[
      discarded
    ] as number;
    expect(recordedOrder).toBeLessThan(discardedOrder);
    await resetApiBase();
  });

  it("a rolled-back server switch leaves no pending revocation", async () => {
    for (const failure of ["clear", "endpoint"] as const) {
      const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
      mockSecureStore(store);
      if (failure === "clear") {
        vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
          if (key === "rakazo.session_token") throw new Error("device locked");
          store.delete(key);
        });
        vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
          if (key === "rakazo.session_token") throw new Error("device locked");
          store.set(key, value);
        });
      } else {
        vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
          if (key === "rakazo.api_base") throw new Error("device locked");
          store.set(key, value);
        });
      }

      const saved = saveApiBase("https://second-server.example");
      await expect(saved).resolves.toMatchObject({ ok: false });
      // The switch rolled back, so the session it recorded a revocation for stays in use.
      expect(pendingSignOutRecords(store)).toEqual([]);
    }
  });

  it("aborts a server switch when the revocation cannot be recorded", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await saveApiBase("https://second-server.example");
    store.set("rakazo.session_token", "session-token");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.pending_sign_out") throw new Error("device locked");
      store.set(key, value);
    });

    // Without the record the old server keeps its session forever, so the switch stops.
    await expect(resetApiBase()).resolves.toEqual({
      ok: false,
      error: "Could not save the previous server session",
    });
    expect(store.get("rakazo.session_token")).toBe("session-token");
    expect(store.get("rakazo.api_base")).toBe("https://second-server.example");

    await expect(saveApiBase("https://third-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not save the previous server session",
    });
    expect(store.get("rakazo.session_token")).toBe("session-token");
    // Restore writable storage so the cleanup switch can record its own revocation.
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      store.set(key, value);
    });
    await resetApiBase();
  });

  it("a flush racing a failing server switch cannot revoke the old session", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "token-a"]]);
    mockSecureStore(store);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token") throw new Error("device locked");
      store.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") {
        // An answered request retries the record at the moment the switch starts clearing.
        await flushPendingSignOut();
        throw new Error("device locked");
      }
      store.delete(key);
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const next =
      currentApiBase() === "https://second-server.example"
        ? "https://third-server.example"
        : "https://second-server.example";

    await expect(saveApiBase(next)).resolves.toMatchObject({ ok: false });

    expect(fetchMock.mock.calls).toEqual([]);
    expect(pendingSignOutRecords(store)).toEqual([]);
    expect(store.get("rakazo.session_token")).toBe("token-a");
  });

  it("delivers a provisional record a failed promotion left behind", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "token-a"]]);
    mockSecureStore(store);
    let pendingWrites = 0;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.pending_sign_out") {
        pendingWrites += 1;
        // The switch's own write lands; the promotion at commit does not.
        if (pendingWrites === 2) throw new Error("device locked");
        store.set(key, value);
        return;
      }
      store.set(key, value);
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toMatchObject({ ok: true });
    const stored = JSON.parse(store.get("rakazo.pending_sign_out") ?? "[]") as {
      provisional?: boolean;
    }[];
    expect(stored.length).toBe(1);
    expect(stored[0]?.provisional).toBe(true);

    // An ordinary flush — not a launch — resolves the leftover record and delivers it.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await flushPendingSignOut();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/api/auth/sign-out",
    ]);
    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it("a reconcile suspended mid-read leaves a starting switch's record alone", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "token-a"]]);
    store.set(
      "rakazo.pending_sign_out",
      JSON.stringify([
        {
          apiBase: "http://127.0.0.1:3100",
          token: "token-a",
          headers: {},
          recordedAt: Date.now(),
          provisional: true,
        },
      ]),
    );
    mockSecureStore(store);
    let releaseSessionRead: (() => void) | undefined;
    let sessionReads = 0;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") {
        sessionReads += 1;
        if (sessionReads === 1)
          await new Promise<void>((resolve) => {
            releaseSessionRead = resolve;
          });
      }
      return store.get(key) ?? null;
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") throw new Error("device locked");
      store.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token") throw new Error("device locked");
      store.set(key, value);
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    // The reconcile suspends reading the session; the switch starts while it waits.
    const settling = flushPendingSignOut(true);
    await vi.waitFor(() => expect(sessionReads).toBeGreaterThanOrEqual(1));
    const switching = saveApiBase("https://second-server.example");
    await vi.waitFor(() => expect(sessionReads).toBeGreaterThanOrEqual(2));
    releaseSessionRead?.();
    await settling;
    await expect(switching).resolves.toMatchObject({ ok: false });

    expect(fetchMock.mock.calls).toEqual([]);
    expect(pendingSignOutRecords(store)).toEqual([]);
    expect(store.get("rakazo.session_token")).toBe("token-a");
  });

  it.each(["save", "reset"])(
    "serializes a %s behind an earlier switch rollback",
    async (change) => {
      const store = new Map<string, string>();
      mockSecureStore(store);
      await saveApiBase("https://old-server.example");
      await restoreSessionToken("token-a");
      let failEndpointWrite: (() => void) | undefined;
      let endpointWrites = 0;
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
        if (key === "rakazo.api_base") {
          endpointWrites += 1;
          if (endpointWrites === 1) {
            await new Promise((_resolve, reject) => {
              failEndpointWrite = () => reject(new Error("device locked"));
            });
          }
        }
        store.set(key, value);
      });
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
      vi.stubGlobal("fetch", fetchMock);

      // This switch clears the old credentials, then parks before committing.
      const first = saveApiBase("https://second-server.example");
      await vi.waitFor(() => expect(failEndpointWrite).toBeTruthy());
      const second =
        change === "save" ? saveApiBase("https://third-server.example") : resetApiBase();
      try {
        // Give the overlapping transaction and reconciliation the same storage window.
        await flushPendingSignOut(true);
        expect(fetchMock.mock.calls).toEqual([]);
      } finally {
        failEndpointWrite?.();
      }
      await expect(first).resolves.toMatchObject({ ok: false });
      await expect(second).resolves.toMatchObject({ ok: true });
      expect(currentApiBase()).toBe(
        change === "save" ? "https://third-server.example" : "http://127.0.0.1:3100",
      );
      expect(store.has("rakazo.session_token")).toBe(false);
      expect(pendingSignOutRecords(store)).toEqual([
        { apiBase: "https://old-server.example", token: "token-a" },
      ]);
      await resetApiBase();
    },
  );

  it.each(["save", "reset"])(
    "a %s rollback preserves a newer explicit sign-out record",
    async (change) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now());
      const store = new Map<string, string>();
      mockSecureStore(store);
      if (change === "reset") await saveApiBase("https://old-server.example");
      const apiBase = currentApiBase();
      await restoreSessionToken("token-a");
      await selectSpace("space-old");
      let releaseRollback!: () => void;
      const rollbackStarted = new Promise<void>((resolve) => {
        vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
          if (key === "rakazo.space_rollback" && value) {
            resolve();
            await new Promise<void>((release) => {
              releaseRollback = release;
            });
            throw new Error("device locked");
          }
          store.set(key, value);
        });
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("offline");
        }),
      );

      const switching =
        change === "save" ? saveApiBase("https://second-server.example") : resetApiBase();
      await rollbackStarted;
      // The provisional record is durable; the old session has not been cleared yet.
      const signingOut = signOut();
      try {
        await vi.waitFor(() => {
          const records = JSON.parse(store.get("rakazo.pending_sign_out") ?? "[]");
          expect(records).toHaveLength(1);
          expect(records[0].provisional).toBeUndefined();
        });
      } finally {
        releaseRollback();
      }
      await expect(switching).resolves.toMatchObject({ ok: false });
      await signingOut;
      expect(pendingSignOutRecords(store)).toEqual([{ apiBase, token: "token-a" }]);
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
        store.set(key, value);
      });
      await resetApiBase();
    },
  );

  it("aborts a server switch when the session cannot be read", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    let sessionReads = 0;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") {
        sessionReads += 1;
        // The switch's own read fails; a later read would see the session again.
        if (sessionReads === 1) throw new Error("device locked");
      }
      return store.get(key) ?? null;
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not save the previous server session",
    });
    // Without knowing whether the old server has a session, the switch clears nothing.
    expect(store.get("rakazo.session_token")).toBe("session-token");
    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it.each(["the call hang-up", "the space rollback write"])(
    "a save never clears a session that replaced the recorded one during %s",
    async (during) => {
      const store = new Map<string, string>();
      mockSecureStore(store);
      await restoreSessionToken("token-a");
      await selectSpace("space-old");
      // An earlier failed switch left the selection stored only in its rollback record.
      store.delete("rakazo.space_id");
      const signIn = () => saveSessionToken("token-b");
      if (during === "the call hang-up") {
        configureSessionEndHangUp(signIn);
      } else {
        vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
          if (key === "rakazo.space_rollback" && value) await signIn();
          store.set(key, value);
        });
      }
      let result: Awaited<ReturnType<typeof saveApiBase>>;
      try {
        result = await saveApiBase("https://second-server.example");
      } finally {
        configureSessionEndHangUp(undefined);
        mockSecureStore(store);
      }

      if (during === "the call hang-up") {
        // The switch reads the session after the hang-up, so it revokes the session it clears.
        expect(result).toMatchObject({ ok: true });
        expect(store.has("rakazo.session_token")).toBe(false);
        expect(pendingSignOutRecords(store).map((record) => record.token)).toEqual(["token-b"]);
      } else {
        // A session that changed after the read stops the switch before it clears anything.
        expect(result).toMatchObject({ ok: false });
        expect(store.get("rakazo.session_token")).toBe("token-b");
        expect(pendingSignOutRecords(store)).toEqual([]);
        expect(store.get("rakazo.space_id")).toBe("space-old");
      }
      await resetApiBase();
    },
  );

  it("a save stops while a session save started during the hang-up is still running", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    let releaseSave!: () => void;
    const saveHeld = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let saving: Promise<void> | undefined;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token" && value === "token-b") await saveHeld;
      // The save completes while the switch writes the Space rollback.
      if (key === "rakazo.space_rollback" && value) {
        releaseSave();
        await saving;
      }
      store.set(key, value);
    });
    configureSessionEndHangUp(async () => {
      saving = saveSessionToken("token-b");
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase("https://second-server.example");
    } finally {
      configureSessionEndHangUp(undefined);
      releaseSave();
      await saving;
      mockSecureStore(store);
    }

    expect(result).toMatchObject({ ok: false });
    expect(store.get("rakazo.session_token")).toBe("token-b");
    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it("a save revokes a stored session that a failed save during the hang-up left unsent", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token" && value === "token-b") throw new Error("device locked");
      store.set(key, value);
    });
    configureSessionEndHangUp(() => saveSessionToken("token-b"));
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase("https://second-server.example");
    } finally {
      configureSessionEndHangUp(undefined);
      mockSecureStore(store);
    }

    // The failed save left token-a stored; a restart would send it, so the switch revokes it.
    expect(result).toMatchObject({ ok: true });
    expect(store.has("rakazo.session_token")).toBe(false);
    expect(pendingSignOutRecords(store).map((record) => record.token)).toEqual(["token-a"]);
    await resetApiBase();
  });

  it.each(["save", "reset"])(
    "a %s rolled back after clearing a stored session a failed save left unsent keeps its revocation",
    async (change) => {
      const store = new Map<string, string>();
      mockSecureStore(store);
      if (change === "reset") await saveApiBase("https://old-server.example");
      await restoreSessionToken("token-a");
      await selectSpace("space-old");
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
        if (key === "rakazo.session_token" && value === "token-b") throw new Error("device locked");
        if (change === "save" && key === "rakazo.api_base") throw new Error("device locked");
        store.set(key, value);
      });
      vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
        if (change === "reset" && key === "rakazo.api_base") throw new Error("device locked");
        store.delete(key);
      });
      configureSessionEndHangUp(() => saveSessionToken("token-b"));
      let result: Awaited<ReturnType<typeof saveApiBase>>;
      try {
        result = await (change === "save"
          ? saveApiBase("https://second-server.example")
          : resetApiBase());
      } finally {
        configureSessionEndHangUp(undefined);
        mockSecureStore(store);
      }

      // The rollback does not bring token-a back, so its revocation stays owed.
      expect(result).toMatchObject({ ok: false });
      expect(store.has("rakazo.session_token")).toBe(false);
      expect(await authHeaders()).not.toHaveProperty("authorization");
      expect(pendingSignOutRecords(store).map((record) => record.token)).toEqual(["token-a"]);
      await resetApiBase();
    },
  );

  it.each([
    ["save", "nothing"],
    ["save", "a sign-in during the rollback"],
    ["save", "a sign-in after the rollback"],
    ["reset", "nothing"],
    ["reset", "a sign-in during the rollback"],
    ["reset", "a sign-in after the rollback"],
  ])(
    "a %s rolled back after clearing an unsent stored session revokes it unless %s reactivates it",
    async (change, reactivation) => {
      const store = new Map<string, string>();
      mockSecureStore(store);
      if (change === "reset") await saveApiBase("https://old-server.example");
      const previous = currentApiBase();
      await restoreSessionToken("token-a");
      await selectSpace("space-old");
      let rollingBack = false;
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
        if (key === "rakazo.session_token" && value === "token-b") throw new Error("device locked");
        if (change === "save" && key === "rakazo.api_base") {
          rollingBack = true;
          throw new Error("device locked");
        }
        // The rollback restores the Space; a sign-in that returns token-a lands meanwhile.
        if (
          key === "rakazo.space_id" &&
          rollingBack &&
          reactivation === "a sign-in during the rollback"
        ) {
          rollingBack = false;
          await saveSessionToken("token-a");
        }
        store.set(key, value);
      });
      vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
        if (change === "reset" && key === "rakazo.api_base") {
          rollingBack = true;
          throw new Error("device locked");
        }
        store.delete(key);
      });
      configureSessionEndHangUp(() => saveSessionToken("token-b"));
      let result: Awaited<ReturnType<typeof saveApiBase>>;
      try {
        result = await (change === "save"
          ? saveApiBase("https://second-server.example")
          : resetApiBase());
      } finally {
        configureSessionEndHangUp(undefined);
        mockSecureStore(store);
      }
      if (reactivation === "a sign-in after the rollback") await saveSessionToken("token-a");
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
      vi.stubGlobal("fetch", fetchMock);
      await flushPendingSignOut(true);

      expect(result).toMatchObject({ ok: false });
      const signOuts = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/auth/sign-out"),
      );
      if (reactivation === "nothing") {
        expect(signOuts.map(([url]) => url)).toEqual([`${previous}/api/auth/sign-out`]);
        const [, init] = signOuts[0] as [string, RequestInit];
        expect(init.headers).toMatchObject({
          authorization: "Bearer token-a",
        });
      } else {
        // The session in use again is not revoked.
        expect(signOuts).toEqual([]);
        expect(store.get("rakazo.session_token")).toBe("token-a");
      }
      expect(pendingSignOutRecords(store)).toEqual([]);
      await resetApiBase();
    },
  );

  it("a save stopped by a session change stores a Space selected during its restoring write", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    let selecting: Promise<boolean> | undefined;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback" && value) await saveSessionToken("token-b");
      if (key === "rakazo.space_id" && value === "space-old" && !selecting) {
        // A new selection lands before the switch's restoring write.
        selecting = selectSpace("space-new");
        await selecting;
      }
      store.set(key, value);
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase("https://second-server.example");
    } finally {
      mockSecureStore(store);
    }

    expect(selecting).toBeDefined();
    expect(result).toMatchObject({ ok: false });
    expect(selectedSpaceId()).toBe("space-new");
    expect(store.get("rakazo.space_id")).toBe("space-new");
    expect(store.has("rakazo.space_rollback")).toBe(false);
    await resetApiBase();
  });

  it("a save stopped by a session change stores the last Space selected during its repair", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    let selecting: Promise<boolean> | undefined;
    let reselecting: Promise<boolean> | undefined;
    let newWrites = 0;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback" && value) await saveSessionToken("token-b");
      if (key === "rakazo.space_id" && value === "space-old" && !selecting) {
        selecting = selectSpace("space-new");
        await selecting;
      }
      // The second write of space-new is the switch's repair; another selection lands first.
      if (key === "rakazo.space_id" && value === "space-new" && ++newWrites === 2) {
        reselecting = selectSpace("space-newest");
        await reselecting;
      }
      store.set(key, value);
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase("https://second-server.example");
    } finally {
      mockSecureStore(store);
    }

    expect(reselecting).toBeDefined();
    expect(result).toMatchObject({ ok: false });
    expect(selectedSpaceId()).toBe("space-newest");
    expect(store.get("rakazo.space_id")).toBe("space-newest");
    expect(store.has("rakazo.space_rollback")).toBe(false);
    await resetApiBase();
  });

  it("a save stopped by a session change keeps a Space selected while it read the old one", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await clearSpace();
    // Stored but not yet cached, so the switch reads the selection from the store.
    store.set("rakazo.space_id", "space-old");
    let selecting: Promise<boolean> | undefined;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      const value = store.get(key) ?? null;
      if (key === "rakazo.space_id" && !selecting) {
        // A new selection lands after the switch read the old one.
        selecting = selectSpace("space-new");
        await selecting;
      }
      return value;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback" && value) await saveSessionToken("token-b");
      store.set(key, value);
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase("https://second-server.example");
    } finally {
      mockSecureStore(store);
    }

    expect(selecting).toBeDefined();
    expect(result).toMatchObject({ ok: false });
    expect(store.get("rakazo.space_id")).toBe("space-new");
    expect(store.has("rakazo.space_rollback")).toBe(false);
    await resetApiBase();
  });

  it("a reset that cannot store the old server again keeps its session revoked, not restored", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await saveApiBase("https://old-server.example");
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      store.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.server_headers") throw new Error("device locked");
      store.delete(key);
    });
    let result: Awaited<ReturnType<typeof resetApiBase>>;
    try {
      result = await resetApiBase();
    } finally {
      mockSecureStore(store);
    }
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await flushPendingSignOut(true);

    // The next launch opens the default server, so the old session is revoked, not restored.
    expect(result).toMatchObject({ ok: false });
    expect(store.has("rakazo.api_base")).toBe(false);
    expect(store.has("rakazo.session_token")).toBe(false);
    const signOuts = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/auth/sign-out"),
    );
    expect(signOuts.map(([url]) => url)).toEqual(["https://old-server.example/api/auth/sign-out"]);
    const [, init] = signOuts[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ authorization: "Bearer token-a" });
    await resetApiBase();
  });

  it("a reset that cannot store the old server again signs in to the server the next launch opens", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await saveApiBase("https://old-server.example");
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      store.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.server_headers") throw new Error("device locked");
      store.delete(key);
    });
    let result: Awaited<ReturnType<typeof resetApiBase>>;
    try {
      result = await resetApiBase();
    } finally {
      mockSecureStore(store);
    }
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("/api/auth/sign-in/email")
        ? jsonResponse({ token: "token-c" })
        : jsonResponse({}),
    );
    vi.stubGlobal("fetch", fetchMock);
    await signIn("ada@example.com", "correct horse");
    await loadApiBase();

    // The token comes from the server a restart opens, so it is never sent to another one.
    expect(result).toMatchObject({ ok: false });
    const signIns = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/auth/sign-in/email"),
    );
    expect(signIns.map(([url]) => url)).toEqual([`${currentApiBase()}/api/auth/sign-in/email`]);
    expect(currentApiBase()).toBe("http://127.0.0.1:3100");
    expect(await authHeaders(null)).toMatchObject({ authorization: "Bearer token-c" });
    await resetApiBase();
  });

  it("a rolled-back switch keeps the revocation of a session it could only restore in memory", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      if (key === "rakazo.session_token") throw new Error("device locked");
      store.set(key, value);
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase("https://second-server.example");
    } finally {
      mockSecureStore(store);
    }

    // A restart would not find token-a, so its revocation record stays for the next retry.
    expect(result).toMatchObject({ ok: false });
    expect(store.has("rakazo.session_token")).toBe(false);
    expect(await authHeaders(null)).toMatchObject({ authorization: "Bearer token-a" });
    expect(pendingSignOutRecords(store).map((record) => record.token)).toEqual(["token-a"]);
  });

  it("a flush keeps the revocation of a rolled-back session kept only in memory", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      if (key === "rakazo.session_token") throw new Error("device locked");
      store.set(key, value);
    });
    try {
      await saveApiBase("https://second-server.example");
    } finally {
      mockSecureStore(store);
    }
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await flushPendingSignOut(true);

    // token-a is still in use, so it is not revoked; a restart loses it, so the record stays.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pendingSignOutRecords(store).map((record) => record.token)).toEqual(["token-a"]);
  });

  it("a flush during a save of a memory-only session does not revoke it", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      if (key === "rakazo.session_token") throw new Error("device locked");
      store.set(key, value);
    });
    try {
      await saveApiBase("https://second-server.example");
    } finally {
      mockSecureStore(store);
    }
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await flushPendingSignOut(true);
    let releaseSave!: () => void;
    const saveHeld = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token") await saveHeld;
      store.set(key, value);
    });
    // The same token is saved again; a flush runs while its write is held.
    const saving = saveSessionToken("token-a");
    await flushPendingSignOut(true);
    releaseSave();
    await saving;
    mockSecureStore(store);
    await flushPendingSignOut(true);

    // token-a is in use and now stored, so it is never revoked and its record is dropped.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get("rakazo.session_token")).toBe("token-a");
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it("a hung session save defers only the current server's switch records", async () => {
    const record = (apiBase: string, token: string) => ({
      apiBase,
      token,
      headers: {},
      recordedAt: Date.now(),
      provisional: true,
    });
    const store = new Map<string, string>([
      [
        "rakazo.pending_sign_out",
        JSON.stringify([
          record("https://old-server.example", "token-a"),
          record(currentApiBase(), "token-c"),
        ]),
      ],
    ]);
    mockSecureStore(store);
    let releaseSave!: () => void;
    const saveHeld = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token") await saveHeld;
      store.set(key, value);
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const signOuts = () =>
      fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith("/api/auth/sign-out"))
        .map(([url, init]) => [url, new Headers(init?.headers).get("authorization")]);
    const saving = saveSessionToken("token-b");
    await flushPendingSignOut(true);

    // The other server's session cannot be the one being saved here, so it is revoked now.
    expect(signOuts()).toEqual([
      ["https://old-server.example/api/auth/sign-out", "Bearer token-a"],
    ]);
    expect(pendingSignOutRecords(store).map((entry) => entry.token)).toEqual(["token-c"]);

    releaseSave();
    await saving;
    await flushPendingSignOut(true);
    expect(signOuts()).toEqual([
      ["https://old-server.example/api/auth/sign-out", "Bearer token-a"],
      [`${currentApiBase()}/api/auth/sign-out`, "Bearer token-c"],
    ]);
  });

  it("a server switch stops when a session is saved while it clears the old one", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    const previous = currentApiBase();
    await restoreSessionToken("token-a");
    let signIn = true;
    vi.mocked(stopLiveNotifications).mockImplementation(async () => {
      // A sign-in on the old server saves its token while the clear stops notifications.
      if (signIn) {
        signIn = false;
        await saveSessionToken("token-b");
      }
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase("https://second-server.example");
    } finally {
      vi.mocked(stopLiveNotifications).mockImplementation(async () => undefined);
    }

    // The old server's token is never sent to the new server.
    expect(result).toEqual({ ok: false, error: "Could not clear the previous server session" });
    expect(currentApiBase()).toBe(previous);
    expect(store.get("rakazo.session_token")).toBe("token-b");
    expect(await authHeaders(null)).toMatchObject({ authorization: "Bearer token-b" });
    // The cleared session is gone from the device, so its revocation stays.
    expect(pendingSignOutRecords(store).map((record) => record.token)).toEqual(["token-a"]);
  });

  it("records no revocation when switching servers without a session", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);

    await expect(saveApiBase("https://second-server.example")).resolves.toMatchObject({ ok: true });

    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it("refuses to switch endpoints when SecureStore cannot clear credentials", async () => {
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(new Error("device locked"));
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("device locked"));

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not clear the previous server session",
    });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      "rakazo.api_base",
      "https://second-server.example",
    );
  });

  it("restores notifications to the selected space when endpoint rollback succeeds", async () => {
    const previousApiBase = currentApiBase();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") return "session-token";
      return null;
    });
    await selectSpace("space-social");
    await selectSpace("space-support");
    vi.mocked(resumeLiveNotifications).mockClear();
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token" || (key === "rakazo.space_id" && value === "")) {
        throw new Error("device locked");
      }
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not clear the previous server session",
    });
    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      "rakazo.api_base",
      "https://second-server.example",
    );
    expect(resumeLiveNotifications).toHaveBeenCalledWith(
      previousApiBase,
      "session-token",
      "space-support",
    );
  });

  it("reports a failed clear when the remembered organization Spaces stay on the device", async () => {
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.org_spaces") throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.org_spaces") throw new Error("device locked");
    });

    await expect(clearSpace()).resolves.toBe(false);
  });

  it("restores credentials when the new endpoint cannot be persisted", async () => {
    const previous = currentApiBase();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") return "session-token";
      return null;
    });
    await selectSpace("space-support");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not save the server URL",
    });
    expect(currentApiBase()).toBe(previous);
    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalledWith("rakazo.org_spaces");
  });

  it("restores a persisted space when its initial load failed", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    await loadApiBase();
    const previous = currentApiBase();
    let spaceReads = 0;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key !== "rakazo.space_id") return null;
      spaceReads += 1;
      if (spaceReads === 1) throw new Error("device locked");
      return "space-support";
    });
    await loadApiBase();
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not save the server URL",
    });
    expect(currentApiBase()).toBe(previous);
    await expect(authHeaders()).resolves.toEqual({
      "x-rakazo-space-id": "space-support",
    });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.space_id", "space-support");
  });

  it("refuses an endpoint switch when the active space cannot be snapshotted", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    await loadApiBase();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
      return null;
    });
    await loadApiBase();
    vi.mocked(SecureStore.deleteItemAsync).mockClear();

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not clear the previous server session",
    });
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("preserves credentials when the active session cannot be snapshotted", async () => {
    await saveSessionToken("session-token");
    await selectSpace("space-support");
    vi.mocked(SecureStore.getItemAsync).mockRejectedValue(new Error("device locked"));
    vi.mocked(SecureStore.deleteItemAsync).mockClear();
    const previous = currentApiBase();
    const next =
      previous === "https://second-server.example"
        ? "https://third-server.example"
        : "https://second-server.example";

    await expect(saveApiBase(next)).resolves.toEqual({
      ok: false,
      error: "Could not save the previous server session",
    });
    expect(currentApiBase()).toBe(previous);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();

    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
      key === "rakazo.session_token" ? "session-token" : null,
    );
    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
  });

  it("keeps an invalidated empty session fail closed during credential rollback", async () => {
    await saveSessionToken("session-token");
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token" && value === "") throw new Error("device locked");
    });
    await expect(clearSessionToken()).resolves.toBe(false);
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("stale-session-token");
    const previous = currentApiBase();
    const next =
      previous === "https://second-server.example"
        ? "https://third-server.example"
        : "https://second-server.example";

    await expect(saveApiBase(next)).resolves.toEqual({
      ok: false,
      error: "Could not clear the previous server session",
    });
    expect(currentApiBase()).toBe(previous);
    await expect(snapshotSessionToken()).resolves.toEqual({ ok: true, value: "" });

    await saveSessionToken("session-token");
  });

  it("keeps the in-memory session across consecutive failed endpoint switches", async () => {
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") return "session-token";
      return null;
    });
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token" || (key === "rakazo.space_id" && value === "")) {
        throw new Error("device locked");
      }
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toMatchObject({
      ok: false,
    });
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    await expect(saveApiBase("https://third-server.example")).resolves.toMatchObject({ ok: false });

    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      "rakazo.api_base",
      expect.stringMatching(/second-server|third-server/),
    );
  });

  it("restores credentials when resetting the endpoint cannot be persisted", async () => {
    await saveApiBase("https://second-server.example");
    const previous = currentApiBase();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") return "session-token";
      return null;
    });
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
    });

    await expect(resetApiBase()).resolves.toEqual({
      ok: false,
      error: "Could not clear the custom server URL",
    });
    expect(currentApiBase()).toBe(previous);
    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });

    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    await resetApiBase();
  });

  it("recovers a deleted-space fallback over a stale saved selection after restart", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
      storage.set(key, value);
    });
    await loadApiBase();

    await expect(selectSpace("space-personal")).resolves.toBe(false);
    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-personal");
    // Stale deleted id is cleared even while the replacement write stays locked.
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-personal" }),
    );

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });

  it("clears a deleted selection when every SecureStore write fails after delete", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    await loadApiBase();

    await expect(selectSpace("space-personal")).resolves.toBe(false);
    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-personal");
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(storage.has("rakazo.space_rollback")).toBe(false);

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    // Cleared selection lets startup fall through to the server default.
    expect(restartedApi.selectedSpaceId()).toBeNull();
    await expect(restartedApiServer.selectInitialSpace("space-personal")).resolves.toBe(true);
    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
  });

  it("drops a stale deleted selection when rollback recovery cannot rewrite SPACE_KEY", async () => {
    const storage = new Map<string, string>([
      ["rakazo.space_id", "space-deleted"],
      [
        "rakazo.space_rollback",
        JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-personal" }),
      ],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();

    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-personal" }),
    );
  });

  it("recovers after restart when SecureStore could neither write nor clear after delete", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    await loadApiBase();

    await expect(selectSpace("space-personal")).resolves.toBe(false);
    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-deleted");

    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBe("space-deleted");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(jsonResponse({ json: { spaces: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(restartedApi.rpc("spaces/list")).resolves.toEqual({ spaces: [] });
    expect(restartedApi.selectedSpaceId()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1].headers["x-rakazo-space-id"]).toBe("space-deleted");
    expect(fetchMock.mock.calls[1]![1].headers["x-rakazo-space-id"]).toBeUndefined();
  });

  it("does not let a stale rollback override a saved deleted-space fallback", async () => {
    const apiBase = "http://127.0.0.1:3100";
    const storage = new Map<string, string>([
      ["rakazo.space_id", "space-deleted"],
      ["rakazo.space_rollback", JSON.stringify({ apiBase, spaceId: "space-old" })],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      // clearStoredValue falls back to writing ""; keep that failing for rollback
      // so only an overwrite of the rollback payload can neutralize it.
      if (key === "rakazo.space_rollback" && value === "") throw new Error("device locked");
      storage.set(key, value);
    });
    await loadApiBase();

    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
    // Neutralization overwrote the stale rollback; best-effort clear may leave
    // the matching recovery payload when delete/empty writes stay locked.
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase, spaceId: "space-personal" }),
    );

    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
  });

  it("does not write SPACE_KEY beside a stale rollback when neutralization fails", async () => {
    const apiBase = "http://127.0.0.1:3100";
    const storage = new Map<string, string>([
      ["rakazo.space_id", "space-deleted"],
      ["rakazo.space_rollback", JSON.stringify({ apiBase, spaceId: "space-old" })],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
      // Block recoverSpaceRollback during loadApiBase, and block SPACE_KEY clears.
      // Writes of the new fallback id would succeed — the bug was doing that write
      // before neutralization, then failing to undo it.
      if (key === "rakazo.space_id" && (value === "" || value === "space-old")) {
        throw new Error("device locked");
      }
      storage.set(key, value);
    });
    await loadApiBase();

    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-personal");
    // Must not leave the new selection durable beside the stale rollback.
    expect(storage.get("rakazo.space_id")).toBe("space-deleted");
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase, spaceId: "space-old" }),
    );

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    // Restart may still recover the old rollback target, but must not have
    // replaced a newer SPACE_KEY fallback with it.
    expect(restartedApi.selectedSpaceId()).toBe("space-old");
    expect(storage.get("rakazo.space_id")).toBe("space-old");
  });

  it("heals durable divergence when persisting a new Space fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    await loadApiBase();
    await expect(selectSpace("space-support")).resolves.toBe(true);
    // A concurrent recovery persisted the claimed id, then the selection
    // write below fails and rolls the claim back.
    storage.set("rakazo.space_id", "space-new");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-new") {
        throw new Error("device locked");
      }
      storage.set(key, value);
    });

    await expect(selectSpace("space-new")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-support");
    expect(storage.get("rakazo.space_id")).toBe("space-support");
  });

  it("keeps a newer overlapping selection when an older persist fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    let rejectA!: (reason: Error) => void;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        await new Promise<never>((_, reject) => {
          rejectA = reject;
        });
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    rejectA(new Error("device locked"));

    await expect(pendingA).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
  });

  it("does not commit a selection superseded during rollback cleanup", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-current"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    let releaseOlderCleanup!: () => void;
    let heldOlderCleanup = false;
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback" && !heldOlderCleanup) {
        heldOlderCleanup = true;
        await new Promise<void>((resolve) => {
          releaseOlderCleanup = resolve;
        });
      }
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();
    expect(selectedSpaceId()).toBe("space-current");

    const previousSeq = spaceSelectionSeq();
    const pendingOlder = selectSpace("space-older");
    expect(spaceSelectionSeq()).toBe(previousSeq + 1);
    expect(selectedSpaceId()).toBe("space-current");
    await vi.waitFor(() => expect(heldOlderCleanup).toBe(true));
    await expect(selectSpace("space-newer")).resolves.toBe(true);
    expect(spaceSelectionSeq()).toBe(previousSeq + 2);
    expect(selectedSpaceId()).toBe("space-newer");
    expect(storage.get("rakazo.space_id")).toBe("space-newer");

    releaseOlderCleanup();
    await expect(pendingOlder).resolves.toBe(false);
    expect(spaceSelectionSeq()).toBe(previousSeq + 2);
    expect(selectedSpaceId()).toBe("space-newer");
    expect(storage.get("rakazo.space_id")).toBe("space-newer");
  });

  it("converges durable state to the latest overlapping selection", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    let resolveA!: () => void;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        await new Promise<void>((resolve) => {
          resolveA = resolve;
        });
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    // The older write lands stale after the newer one completed.
    resolveA();

    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
    expect(resumeLiveNotifications).toHaveBeenCalledTimes(1);
    expect(resumeLiveNotifications).toHaveBeenLastCalledWith(
      currentApiBase(),
      expect.anything(),
      "space-b",
    );
  });

  it("does not restore the first selection after switching away and back", async () => {
    const storage = new Map<string, string>([["rakazo.session_token", "fake-token"]]);
    let releaseFirstA!: () => void;
    let firstA = true;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a" && firstA) {
        firstA = false;
        await new Promise<void>((resolve) => {
          releaseFirstA = resolve;
        });
      }
      storage.set(key, value);
    });
    await loadApiBase();
    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(firstA).toBe(false));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    await expect(selectSpace("space-a")).resolves.toBe(true);
    releaseFirstA();
    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-a");
    expect(storage.get("rakazo.space_id")).toBe("space-a");
    expect(resumeLiveNotifications).toHaveBeenCalledTimes(2);
    expect(resumeLiveNotifications).toHaveBeenLastCalledWith(
      currentApiBase(),
      "fake-token",
      "space-a",
    );
  });

  it("does not restore an obsolete selection after its token read finishes", async () => {
    const storage = new Map<string, string>([["rakazo.session_token", "fake-token"]]);
    let releaseToken!: () => void;
    let tokenReadHeld = false;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token" && !tokenReadHeld) {
        tokenReadHeld = true;
        await new Promise<void>((resolve) => {
          releaseToken = resolve;
        });
      }
      return storage.get(key) ?? null;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    await loadApiBase();

    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(tokenReadHeld).toBe(true));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    releaseToken();
    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
    expect(resumeLiveNotifications).toHaveBeenCalledOnce();
    expect(resumeLiveNotifications).toHaveBeenCalledWith(currentApiBase(), "fake-token", "space-b");
  });

  it("restores notifications for the previous selection when a newer persist fails", async () => {
    const storage = new Map<string, string>([["rakazo.session_token", "fake-token"]]);
    let releaseA!: () => void;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        await new Promise<void>((resolve) => {
          releaseA = resolve;
        });
      }
      if (key === "rakazo.space_id" && value === "space-b") throw new Error("device locked");
      storage.set(key, value);
    });
    await loadApiBase();
    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    // Let rollback's recovery write complete without waiting on the older write.
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-b") throw new Error("device locked");
      storage.set(key, value);
    });
    await expect(selectSpace("space-b")).resolves.toBe(false);
    releaseA();
    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-a");
    expect(storage.get("rakazo.space_id")).toBe("space-a");
    expect(resumeLiveNotifications).toHaveBeenCalledOnce();
    expect(resumeLiveNotifications).toHaveBeenCalledWith(currentApiBase(), "fake-token", "space-a");
  });

  it("keeps a later A claim when an earlier A→B→A persist fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    let firstAWriteCount = 0;
    let rejectFirstA!: (reason: Error) => void;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        firstAWriteCount += 1;
        if (firstAWriteCount === 1) {
          await new Promise<never>((_, reject) => {
            rejectFirstA = reject;
          });
        }
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const pendingFirstA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    await expect(selectSpace("space-a")).resolves.toBe(true);
    expect(storage.get("rakazo.space_id")).toBe("space-a");
    rejectFirstA(new Error("device locked"));

    await expect(pendingFirstA).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-a");
    expect(storage.get("rakazo.space_id")).toBe("space-a");
  });

  it("does not let auth cleanup overwrite a newer selection with a stale snapshot", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    let injected = false;
    let holdCleanupReconcile = false;
    let releaseCleanupWrite!: () => void;
    const cleanupWriteHeld = new Promise<void>((resolve) => {
      releaseCleanupWrite = resolve;
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id" && !injected) {
        injected = true;
        // Finish selecting B before cleanup snapshots it for reconcile.
        await expect(selectSpace("space-b")).resolves.toBe(true);
        holdCleanupReconcile = true;
      }
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-b" && holdCleanupReconcile) {
        holdCleanupReconcile = false;
        // Hold only the post-clear reconcile write of the B snapshot.
        await cleanupWriteHeld;
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(jsonResponse({ json: { spaces: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    const pendingRpc = rpc("spaces/list");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-b"));
    await expect(selectSpace("space-c")).resolves.toBe(true);
    expect(storage.get("rakazo.space_id")).toBe("space-c");
    releaseCleanupWrite();

    await expect(pendingRpc).resolves.toEqual({ spaces: [] });
    expect(selectedSpaceId()).toBe("space-c");
    expect(storage.get("rakazo.space_id")).toBe("space-c");
  });

  it("recovers the active space after rollback persistence fails", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    await loadApiBase();
    await selectSpace("space-support");

    const storage = new Map<string, string>();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base" || (key === "rakazo.space_id" && value === "space-support")) {
        throw new Error("device locked");
      }
      storage.set(key, value);
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not save the server URL",
    });
    await expect(authHeaders()).resolves.toEqual({
      "x-rakazo-space-id": "space-support",
    });
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-support" }),
    );

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();

    expect(restartedApi.selectedSpaceId()).toBe("space-support");
    expect(storage.get("rakazo.space_id")).toBe("space-support");
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });

  it("does not recover a space on a different endpoint", async () => {
    const storage = new Map([
      ["rakazo.api_base", "https://second-server.example"],
      [
        "rakazo.space_rollback",
        JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-support" }),
      ],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");

    await expect(restartedApiServer.loadApiBase()).resolves.toBe("https://second-server.example");
    expect(restartedApi.selectedSpaceId()).toBeNull();
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });

  it("removes a malformed space rollback record", async () => {
    const storage = new Map([["rakazo.space_rollback", "null"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");

    await restartedApiServer.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBeNull();
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });
});
