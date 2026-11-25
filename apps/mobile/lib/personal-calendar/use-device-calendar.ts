import type {
  NativeDeviceOperation,
  NativeDeviceRequest,
  NativeDeviceResponse,
} from "@rakazo/contracts";
import { isNativeClockOperation } from "@rakazo/contracts";
import { anySignal } from "@rakazo/core";
import { useEffect, useLayoutEffect, useRef } from "react";
import { AppState } from "react-native";
import type { RpcOptions } from "../api/api";
import { captureApiRequestContext, currentApiBase, rpc, selectedSpaceId } from "../api/api";
import { useSpaceChanges } from "../api/roster-signals";
import { currentSessionGeneration } from "../api/session";
import { nativeClockDeviceKey } from "../phone-clock/device-clock-key";
import type { ClockConfirmation, ConfirmClock } from "../phone-clock/use-clock-confirmation";
import { useClockConfirmation } from "../phone-clock/use-clock-confirmation";
import { useAppActive } from "../platform/app-foreground";
import { reportMobileError } from "../platform/monitoring";
import { nativeCalendarDeviceKey } from "./device-calendar-key";

let presenting = false;
let queuedRead: (() => void) | undefined;

export function useDeviceCalendar(botId: string | undefined, focused: boolean) {
  const active = useAppActive();
  const { prompt, confirmClock } = useClockConfirmation();
  const enabled = Boolean(
    botId && focused && (nativeClockDeviceKey() || nativeCalendarDeviceKey()),
  );
  const target = useRef<{ botId: string; controller: AbortController } | undefined>(undefined);
  const read = () => {
    const visit = target.current;
    if (!visit || AppState.currentState !== "active") return;
    if (presenting) {
      queuedRead = read;
      return;
    }
    presenting = true;
    void serve(visit.botId, visit.controller.signal, confirmClock)
      .catch((error: unknown) => reportMobileError(error, "rpc.transport"))
      .finally(() => {
        presenting = false;
        const next = queuedRead;
        queuedRead = undefined;
        next?.();
      });
  };
  useLayoutEffect(() => {
    if (!botId || !enabled) return;
    const controller = new AbortController();
    target.current = { botId, controller };
    return () => {
      controller.abort();
      target.current = undefined;
    };
  }, [botId, enabled]);
  useEffect(() => {
    if (active) read();
  }, [active, enabled, botId]);
  useSpaceChanges("nativeCalendar", read, enabled);
  return enabled && active ? prompt : undefined;
}

type Device = { deviceKey: string; capability?: "clock" };
type DeviceVisit = { device: Device; current(): boolean };
type PendingVisit = DeviceVisit & { request: NativeDeviceRequest; expiresAt: number };

async function serve(botId: string, signal: AbortSignal, confirmClock: ConfirmClock) {
  const session = currentSessionGeneration();
  const endpoint = currentApiBase();
  const space = selectedSpaceId();
  const sameSession = () =>
    endpoint === currentApiBase() &&
    space === selectedSpaceId() &&
    session === currentSessionGeneration();
  const current = () => sameSession() && !signal.aborted && AppState.currentState === "active";
  const clockKey = nativeClockDeviceKey();
  const calendarKey = nativeCalendarDeviceKey();
  const clockForeground = new AbortController();
  const clockSignal = anySignal([signal, clockForeground.signal]);
  const foreground =
    clockKey &&
    AppState.addEventListener("change", (state) => {
      if (state !== "active") clockForeground.abort();
    });
  const clockCurrent = () => current() && !clockSignal.aborted;
  try {
    const requestContext = await captureApiRequestContext();
    if (!current()) return;
    const claimOptions = { requestContext, skipSpaceAuthRecovery: true, signal };
    const devices: DeviceVisit[] = [];
    if (clockKey)
      devices.push({ device: { deviceKey: clockKey, capability: "clock" }, current: clockCurrent });
    if (calendarKey) devices.push({ device: { deviceKey: calendarKey }, current });
    // Fetch both pending lists before asking for consent. Oldest deadline wins,
    // while the shared presentation lock still permits only one prompt at a time.
    const pending = await Promise.all(
      devices.map((visit) => readPending(botId, visit, claimOptions)),
    );
    for (const visit of pending.flat().sort((a, b) => a.expiresAt - b.expiresAt)) {
      if (!current()) return;
      try {
        await serveRequest(visit, claimOptions, sameSession, (details) =>
          confirmClock(details, visit.expiresAt, clockSignal),
        );
      } catch (error) {
        if (visit.current()) reportMobileError(error, "rpc.transport");
      }
    }
  } finally {
    if (foreground) foreground.remove();
    clockForeground.abort();
  }
}

async function readPending(
  botId: string,
  visit: DeviceVisit,
  options: RpcOptions,
): Promise<PendingVisit[]> {
  if (!visit.current()) return [];
  // Charge the full request round trip against the server-reported budget.
  const startedAt = performance.now();
  try {
    const pending = await rpc("threads/nativeCalendarPending", { botId, ...visit.device }, options);
    return pending.map((request) => ({
      ...visit,
      request,
      expiresAt: startedAt + request.remainingMs,
    }));
  } catch (error) {
    if (visit.current()) reportMobileError(error, "rpc.transport");
    return [];
  }
}

async function serveRequest(
  { device, request, current, expiresAt }: PendingVisit,
  { signal, ...options }: RpcOptions,
  sameSession: () => boolean,
  confirmClock: (details: ClockConfirmation) => Promise<boolean>,
) {
  const clock = isNativeClockOperation(request.operation);
  if (clock !== (device.capability === "clock")) return;
  const name = clock ? "clock" : "calendar";
  const active = () => current() && performance.now() < expiresAt;
  if (!active()) return;
  const identifiers = { ...requestIds(request), ...device };
  const prepared = await prepareOperation(request.operation, active, confirmClock).catch(
    (error: unknown) => {
      reportMobileError(new Error(`Device ${name} preparation failed`), "rpc.transport", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
      return { status: "unavailable" as const };
    },
  );
  if (!active()) return;

  // Confirm first. The server issues the single-use claim only while the run and
  // its original owner/device still match. Losing this response cannot replay a write.
  const claimStartedAt = performance.now();
  const claimed = await rpc("threads/nativeCalendarClaim", identifiers, { ...options, signal });
  if (!claimed) return;
  expiresAt = Math.min(expiresAt, claimStartedAt + claimed.remainingMs);
  let response: NativeDeviceResponse;
  if (!active() || claimed.operation.action !== request.operation.action)
    response = { status: "unavailable" };
  else if ("status" in prepared) response = prepared;
  else {
    try {
      response = await prepared.perform();
    } catch (error) {
      reportMobileError(new Error(`Device ${name} execution failed`), "rpc.transport", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
      const write = !request.operation.action.startsWith("list_");
      response = { status: write ? "uncertain" : "unavailable" };
    }
  }
  if (sameSession())
    await rpc("threads/nativeCalendarResult", { ...identifiers, response }, options);
}

async function prepareOperation(
  operation: NativeDeviceOperation,
  current: () => boolean,
  confirmClock: (details: ClockConfirmation) => Promise<boolean>,
): Promise<NativeDeviceResponse | { perform(): Promise<NativeDeviceResponse> }> {
  if (isNativeClockOperation(operation)) {
    const { prepareDeviceClock } = await import("../phone-clock/device-clock");
    return prepareDeviceClock(operation, current, confirmClock);
  }
  const { prepareDeviceCalendar, validateDeviceCalendarResult } = await import("./device-calendar");
  const prepared = await prepareDeviceCalendar(operation, current);
  if ("status" in prepared) return prepared;
  return {
    async perform() {
      return validateDeviceCalendarResult(operation, await prepared.perform());
    },
  };
}

function requestIds({ id, runId, threadId }: NativeDeviceRequest) {
  return { id, runId, threadId };
}
