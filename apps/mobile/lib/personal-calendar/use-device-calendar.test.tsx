// @vitest-environment jsdom

import type { NativeDeviceRequest } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
    perform: vi.fn(),
    report: vi.fn(),
  };
});

vi.mock("react-native", () => ({ AppState: mocks.appState, Platform: { OS: "android" } }));
vi.mock("../api/api", () => ({
  captureApiRequestContext: async () => ({}),
  currentApiBase: () => "https://example.test",
  selectedSpaceId: () => "space",
  rpc: mocks.rpc,
}));
vi.mock("../api/roster-signals", () => ({ useSpaceChanges: () => undefined }));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../phone-clock/device-clock", () => ({ prepareDeviceClock: mocks.prepare }));
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
  useDeviceCalendar(botId, focused);
  return null;
}

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("expo", { modules: { RakazoClock: {} }, uuidv4: () => device.deviceKey });
  vi.resetAllMocks();
  mocks.setAppState("active");
  mocks.prepare.mockResolvedValue({ perform: mocks.perform });
  root = createRoot(document.createElement("div"));
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
