import type { AccountNotification } from "@rakazo/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  end: vi.fn(async () => undefined),
  changed: vi.fn(() => false),
  clear: vi.fn(),
  space: vi.fn(() => true),
  effect: vi.fn<(effect: () => undefined | (() => void), dependencies: unknown[]) => void>(),
}));
vi.mock("react", () => ({ useEffect: calls.effect, useSyncExternalStore: vi.fn() }));
vi.mock("./call-session", () => ({
  endCallBeforeSignOut: calls.end,
  sessionChangedUnderPage: calls.changed,
}));
vi.mock("./rpc", () => ({ clearSpaceSelection: calls.clear, selectSpace: calls.space }));
vi.mock("./composer-draft", () => ({ composerHoldsUnsavedWork: () => false }));
const location = { assign: vi.fn(), reload: vi.fn() };
const notification: AccountNotification = {
  id: "reply",
  kind: "completion",
  title: "Chief",
  body: "Done",
  botId: "work-bot",
  threadId: "work-chat",
  spaceId: "work-space",
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  calls.changed.mockReturnValue(false);
  calls.space.mockReturnValue(true);
  vi.stubGlobal("window", { location, confirm: () => true });
});
afterEach(() => vi.unstubAllGlobals());

it("bounds feed requests and aborts a stalled response body", async () => {
  const timeout = new AbortController();
  const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  let requestedSignal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream({ start() {} }));
    }),
  );
  try {
    const { fetchSavedAccounts } = await import("./account-sessions");
    const pending = fetchSavedAccounts();
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(requestedSignal).toBe(timeout.signal));
    timeout.abort(new Error("Timed out"));
    await rejected;
    expect(timer).toHaveBeenCalledWith(8_000);
  } finally {
    timer.mockRestore();
  }
});

it("selects the notification's account before opening its Space and private chat", async () => {
  const { setAccountIdentity, accountRequestHeaders } = await import("./account-identity");
  setAccountIdentity("family");
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ userId: "work" }),
  );
  vi.stubGlobal("fetch", fetch);
  const { switchSavedAccount } = await import("./account-sessions");
  await switchSavedAccount("work", notification);
  expect(fetch).toHaveBeenCalledWith(
    "/api/accounts/select",
    expect.objectContaining({ body: JSON.stringify({ userId: "work" }) }),
  );
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-rakazo-user-id")).toBe("family");
  expect(calls.space).toHaveBeenCalledWith("work-space");
  expect(location.assign).toHaveBeenCalledWith("/app/work-bot");
  expect(() => accountRequestHeaders()).toThrow();
});

it("does not open private content when the target saved session has expired", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 401 })),
  );
  const { switchSavedAccount } = await import("./account-sessions");
  await switchSavedAccount("work", notification);
  expect(calls.space).not.toHaveBeenCalled();
  expect(location.assign).toHaveBeenCalledExactlyOnceWith("/sign-in?add=1");
});

it("does not select an account when another tab changed identity during hang-up", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  calls.changed.mockReturnValue(true);
  const { switchSavedAccount } = await import("./account-sessions");
  await switchSavedAccount("work", notification);
  expect(fetch).not.toHaveBeenCalled();
  expect(location.reload).toHaveBeenCalledOnce();
});

it("keeps polling hidden tabs at a lower rate and cancels the feed on cleanup", async () => {
  vi.useFakeTimers();
  const document = { visibilityState: "hidden" };
  vi.stubGlobal("document", document);
  let signal: AbortSignal | undefined;
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return Response.json({ activeUserId: "family", accounts: [] });
  });
  vi.stubGlobal("fetch", fetch);
  const { useAccountNotifications } = await import("./account-sessions");
  useAccountNotifications("family");
  const cleanup = calls.effect.mock.calls[0]![0]();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    document.visibilityState = "visible";
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    if (typeof cleanup === "function") cleanup();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    if (typeof cleanup === "function") cleanup();
    vi.useRealTimers();
  }
});
