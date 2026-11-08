import { beforeEach, expect, it, vi } from "vitest";
import { mobileBotPackageClient } from "./bot-package-client";
import type { MobileScope } from "./mobile-scope";

const state = vi.hoisted(() => ({ current: true, ready: 1, capture: vi.fn(), rpc: vi.fn() }));
vi.mock("./api", () => ({ captureApiRequestContext: state.capture, rpc: state.rpc }));
vi.mock("./mobile-scope", () => ({ isMobileScopeCurrent: () => state.current }));
vi.mock("./session", () => ({ currentReadySessionGeneration: () => state.ready }));

const scope: MobileScope = {
  apiBase: "https://api.example.test",
  sessionGeneration: 1,
  spaceId: null,
  spaceGeneration: 1,
  selectionSeq: 1,
};
beforeEach(() => {
  vi.clearAllMocks();
  state.current = true;
  state.ready = 1;
  state.capture.mockResolvedValue({ apiBase: scope.apiBase, sessionGeneration: 1, headers: {} });
  state.rpc.mockImplementation(async (procedure) =>
    procedure === "me" ? { userId: "user-a", spaceId: "space-a" } : { receipt: true },
  );
});

it("pins an implicit Space and carries the same scope fence on every package request", async () => {
  const client = await mobileBotPackageClient(scope, () => true);
  const signal = new AbortController().signal;
  await client.request("botPackages/status", { clientNonce: "one-intent" }, signal);
  expect(state.rpc).toHaveBeenLastCalledWith(
    "botPackages/status",
    { clientNonce: "one-intent" },
    {
      requestContext: {
        apiBase: scope.apiBase,
        sessionGeneration: 1,
        headers: { "x-rakazo-space-id": "space-a" },
        isCurrent: client.isCurrent,
      },
      skipSpaceAuthRecovery: true,
      signal,
    },
  );
});

it("does not request or share data when the session is no longer ready", async () => {
  state.ready = 2;
  await expect(mobileBotPackageClient(scope, () => true)).rejects.toThrow("no longer current");
  expect(state.capture).not.toHaveBeenCalled();
  expect(state.rpc).not.toHaveBeenCalled();
});

it("does not use an API context that completed after a scope change", async () => {
  state.capture.mockImplementationOnce(async () => {
    state.current = false;
    return { apiBase: scope.apiBase, sessionGeneration: 1, headers: {} };
  });
  await expect(mobileBotPackageClient(scope, () => true)).rejects.toThrow("no longer current");
  expect(state.rpc).not.toHaveBeenCalled();
});

it("rejects a foreign Space rather than silently importing there", async () => {
  await expect(
    mobileBotPackageClient({ ...scope, spaceId: "space-b" }, () => true),
  ).rejects.toThrow("no longer current");
});

it("discards a package response after a session or Space generation change", async () => {
  const client = await mobileBotPackageClient(scope, () => true);
  state.rpc.mockImplementationOnce(async () => {
    state.current = false;
    return { sensitive: "synthetic" };
  });
  await expect(client.request("botPackages/export", { botId: "bot-one" })).rejects.toThrow(
    "no longer current",
  );
  expect(client.isCurrent()).toBe(false);
});

it("checks cancellation before any package request", async () => {
  const client = await mobileBotPackageClient(scope, () => true);
  const abort = new AbortController();
  abort.abort();
  await expect(
    client.request("botPackages/preview", { source: "{}" }, abort.signal),
  ).rejects.toThrow();
  expect(state.rpc).toHaveBeenCalledTimes(1);
});
