// @vitest-environment jsdom

import type { NativeDeviceRequest } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClockPrompt } from "../phone-clock/use-clock-confirmation";
import { useDeviceCalendar } from "./use-device-calendar";

const mocks = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  const appState = {
    currentState: "active",
    addEventListener: (_: string, listener: (state: string) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  return {
    appState,
    setAppState(state: string) {
      appState.currentState = state;
      for (const listener of listeners) listener(state);
    },
    rpc: vi.fn(),
    prepare: vi.fn(),
    prepareCalendar: vi.fn(),
    perform: vi.fn(),
    report: vi.fn(),
    listen: vi.fn(),
  };
});

vi.mock("react-native", () => ({ AppState: mocks.appState, Platform: { OS: "android" } }));
vi.mock("../api/api", () => ({
  captureApiRequestContext: async () => ({}),
  currentApiBase: () => "https://example.test",
  selectedSpaceId: () => "space",
  rpc: mocks.rpc,
}));
vi.mock("../api/roster-signals", () => ({
  useSpaceChanges: (_signal: string, read: () => void) => mocks.listen(read),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../phone-clock/device-clock", () => ({ prepareDeviceClock: mocks.prepare }));
vi.mock("./device-calendar", () => ({
  prepareDeviceCalendar: mocks.prepareCalendar,
  validateDeviceCalendarResult: vi.fn(),
}));
vi.mock("../platform/monitoring", () => ({ reportMobileError: mocks.report }));

const pending = {
  id: "request",
  runId: "run",
  threadId: "thread",
  remainingMs: 10_000,
  operation: { action: "start_phone_timer", input: { durationSeconds: 60 } },
} satisfies NativeDeviceRequest;
const device = { deviceKey: "clock-proof", capability: "clock" };
const ids = { id: pending.id, runId: pending.runId, threadId: pending.threadId, ...device };
const botId = "bot";

function Probe({ focused }: { focused: boolean }) {
  lastPrompt = useDeviceCalendar(botId, focused);
  return lastPrompt ? (
    <button type="button" onClick={() => lastPrompt?.settle(true)}>
      {lastPrompt.title}
    </button>
  ) : null;
}

let root: Root;
let container: HTMLDivElement;
let lastPrompt: ClockPrompt | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("expo", { modules: { RakazoClock: {} }, uuidv4: () => device.deviceKey });
  vi.resetAllMocks();
  mocks.setAppState("active");
  mocks.prepare.mockResolvedValue({ perform: mocks.perform });
  container = document.createElement("div");
  root = createRoot(container);
  lastPrompt = undefined;
});

afterEach(() => act(() => root.unmount()));

function queueClaim(claim: Promise<NativeDeviceRequest> | NativeDeviceRequest) {
  mocks.rpc.mockResolvedValueOnce([pending]).mockResolvedValueOnce(claim);
}

function expectResult(status: string) {
  return vi.waitFor(() =>
    expect(mocks.rpc).toHaveBeenCalledWith(
      "threads/nativeCalendarResult",
      { ...ids, response: { status } },
      { requestContext: {}, skipSpaceAuthRecovery: true },
    ),
  );
}

it("claims with the clock proof and reports dispatch after Clock takes the foreground", async () => {
  queueClaim(pending);
  mocks.perform.mockImplementation(async () => {
    mocks.setAppState("background");
    return { status: "dispatched" };
  });

  await act(async () => root.render(<Probe focused />));
  await act(async () => expectResult("dispatched"));

  expect(mocks.rpc).toHaveBeenNthCalledWith(
    1,
    "threads/nativeCalendarPending",
    { botId, ...device },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(mocks.rpc).toHaveBeenNthCalledWith(
    2,
    "threads/nativeCalendarClaim",
    ids,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(mocks.perform).toHaveBeenCalledOnce();
});

it.each([
  { ...pending, remainingMs: 0 },
  { ...pending, operation: { action: "set_phone_alarm", input: { hour: 7, minute: 30 } } },
] satisfies NativeDeviceRequest[])(
  "does not dispatch an expired or changed claim ($operation.action)",
  async (claim) => {
    queueClaim(claim);
    await act(async () => root.render(<Probe focused />));
    await expectResult("unavailable");
    expect(mocks.perform).not.toHaveBeenCalled();
  },
);

it("does not dispatch after leaving the focused thread during a claim", async () => {
  const claim = deferred<NativeDeviceRequest>();
  queueClaim(claim.promise);
  await act(async () => root.render(<Probe focused />));
  await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));

  await act(async () => root.render(<Probe focused={false} />));
  await act(async () => claim.resolve(pending));
  await expectResult("unavailable");
  expect(mocks.perform).not.toHaveBeenCalled();
});

it("does not dispatch a claim from an earlier foreground visit", async () => {
  const claim = deferred<NativeDeviceRequest>();
  queueClaim(claim.promise);
  await act(async () => root.render(<Probe focused />));
  await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));

  await act(async () => {
    mocks.setAppState("background");
    mocks.setAppState("active");
    claim.resolve(pending);
  });
  await expectResult("unavailable");
  expect(mocks.perform).not.toHaveBeenCalled();
});

it("handles the earlier calendar request before waiting for Clock consent", async () => {
  const confirmation = deferred<{ status: "cancelled" }>();
  const calendar = {
    ...pending,
    id: "calendar-request",
    remainingMs: 9_000,
    operation: { action: "list_calendars", input: { source: "device" } },
  } satisfies NativeDeviceRequest;
  vi.stubGlobal("expo", {
    modules: { RakazoClock: {}, CalendarNext: {} },
    uuidv4: () => device.deviceKey,
  });
  mocks.prepare.mockReturnValue(confirmation.promise);
  mocks.prepareCalendar.mockResolvedValue({ status: "cancelled" });
  mocks.rpc.mockImplementation(async (method, input) => {
    if (method === "threads/nativeCalendarPending")
      return input.capability === "clock" ? [pending] : [calendar];
    if (method === "threads/nativeCalendarClaim")
      return input.id === pending.id ? pending : calendar;
  });

  await act(async () => root.render(<Probe focused />));
  // A Clock confirmation has not been answered, but the older Calendar request was served.
  const callsBeforeAnswer = [...mocks.rpc.mock.calls];
  await act(async () => confirmation.resolve({ status: "cancelled" }));

  expect(callsBeforeAnswer).toContainEqual([
    "threads/nativeCalendarResult",
    {
      id: calendar.id,
      runId: calendar.runId,
      threadId: calendar.threadId,
      deviceKey: device.deviceKey,
      response: { status: "cancelled" },
    },
    { requestContext: {}, skipSpaceAuthRecovery: true },
  ]);
});

it("reports an uncertain native exception without logging Clock arguments or its message", async () => {
  queueClaim(pending);
  mocks.perform.mockRejectedValue(new Error("private alarm label"));

  await act(async () => root.render(<Probe focused />));
  await expectResult("uncertain");

  expect(mocks.report).toHaveBeenCalledExactlyOnceWith(
    new Error("Device clock execution failed"),
    "rpc.transport",
    { errorType: "Error" },
  );
});

it("dismisses expired Clock consent and then reads the Calendar request that arrived", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const shortClock = { ...pending, remainingMs: 100 };
    const calendar = {
      ...pending,
      id: "later-calendar-request",
      operation: { action: "list_calendars", input: { source: "device" } },
    } satisfies NativeDeviceRequest;
    let calendarAvailable = false;
    vi.stubGlobal("expo", {
      modules: { RakazoClock: {}, CalendarNext: {} },
      uuidv4: () => device.deviceKey,
    });
    mocks.prepare.mockImplementation(async (_operation, _eligible, confirm) =>
      (await confirm({ title: "Clock timer", message: "1 min" }))
        ? { perform: mocks.perform }
        : { status: "cancelled" },
    );
    mocks.prepareCalendar.mockResolvedValue({ status: "cancelled" });
    mocks.rpc.mockImplementation(async (method, input) => {
      if (method === "threads/nativeCalendarPending") {
        if (input.capability === "clock") return performance.now() < 100 ? [shortClock] : [];
        return calendarAvailable ? [calendar] : [];
      }
      if (method === "threads/nativeCalendarClaim")
        return input.id === pending.id ? shortClock : calendar;
    });

    await act(async () => root.render(<Probe focused />));
    expect(container.textContent).toBe("Clock timer");
    expect(lastPrompt).toBeDefined();
    const staleConfirm = lastPrompt?.settle;
    calendarAvailable = true;
    await act(async () => mocks.listen.mock.lastCall?.[0]());
    expect(mocks.prepareCalendar).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(101));
    expect(container.textContent).toBe("");
    await act(async () => staleConfirm?.(true));

    expect(mocks.rpc).toHaveBeenCalledWith(
      "threads/nativeCalendarResult",
      expect.objectContaining({ id: calendar.id, response: { status: "cancelled" } }),
      { requestContext: {}, skipSpaceAuthRecovery: true },
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "threads/nativeCalendarClaim",
      ids,
      expect.anything(),
    );
    expect(mocks.perform).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
