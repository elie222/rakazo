import type {
  NativeDeviceOperation,
  NativeDeviceRequest,
  NativeDeviceResponse,
} from "@rakazo/contracts";
import { isNativeClockOperation } from "@rakazo/contracts";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import type { RpcOptions } from "../api/api";
import { captureApiRequestContext, currentApiBase, rpc, selectedSpaceId } from "../api/api";
import { useSpaceChanges } from "../api/roster-signals";
import { currentSessionGeneration } from "../api/session";
import { nativeClockDeviceKey } from "../phone-clock/device-clock-key";
import { useAppActive } from "../platform/app-foreground";
import { reportMobileError } from "../platform/monitoring";
import { nativeCalendarDeviceKey } from "./device-calendar-key";

let presenting = false;
let queuedRead: (() => void) | undefined;

export function useDeviceCalendar(botId: string | undefined, focused: boolean) {
  const active = useAppActive();
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
    void serve(visit.botId, visit.controller.signal)
      .catch((error: unknown) => reportMobileError(error, "rpc.transport"))
      .finally(() => {
        presenting = false;
        const next = queuedRead;
        queuedRead = undefined;
        next?.();
      });
  };
  useEffect(() => {
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
}

async function serve(botId: string, signal: AbortSignal) {
  const session = currentSessionGeneration();
  const endpoint = currentApiBase();
  const space = selectedSpaceId();
  const sameSession = () =>
    endpoint === currentApiBase() &&
    space === selectedSpaceId() &&
    session === currentSessionGeneration();
  const current = () => sameSession() && !signal.aborted && AppState.currentState === "active";
  const requestContext = await captureApiRequestContext();
  if (!current()) return;
  const options = { requestContext, skipSpaceAuthRecovery: true };
  for (const [deviceKey, capability] of [
    [nativeClockDeviceKey(), "clock"],
    [nativeCalendarDeviceKey(), undefined],
  ] as const) {
    if (!deviceKey || !current()) continue;
    let leftForeground = false;
    // A fast switch away and back can happen during the claim request. Treat the
    // original Clock visit as stale even if its response arrives after reactivation.
    const foreground =
      capability &&
      AppState.addEventListener("change", (state) => {
        if (state !== "active") leftForeground = true;
      });
    try {
      await serveDevice(
        { botId, deviceKey, ...(capability && { capability }) },
        { ...options, signal },
        () => !leftForeground && current(),
        sameSession,
      );
    } catch (error) {
      reportMobileError(error, "rpc.transport");
    } finally {
      foreground?.remove();
    }
  }
}

async function serveDevice(
  { botId, ...device }: { botId: string; deviceKey: string; capability?: "clock" },
  { signal, ...options }: RpcOptions,
  current: () => boolean,
  sameSession: () => boolean,
) {
  // Charge the full request round trip against each server-reported budget.
  // This keeps the device's wall clock out of permission and write decisions.
  const pendingStartedAt = performance.now();
  const pending = await rpc(
    "threads/nativeCalendarPending",
    { botId, ...device },
    { ...options, signal },
  );
  for (const request of pending) {
    if (!current()) return;
    const clock = isNativeClockOperation(request.operation);
    if (clock !== (device.capability === "clock")) continue;
    const name = clock ? "clock" : "calendar";
    let expiresAt = pendingStartedAt + request.remainingMs;
    const active = () => current() && performance.now() < expiresAt;
    if (!active()) continue;
    const identifiers = { ...requestIds(request), ...device };
    const prepared = await prepareOperation(request.operation, active).catch((error: unknown) => {
      reportMobileError(new Error(`Device ${name} preparation failed`), "rpc.transport", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
      return { status: "unavailable" as const };
    });
    if (!current()) return;
    if (!active()) continue;

    // Confirm first. The server issues the single-use claim only while the run and
    // its original owner/device still match. Losing this response cannot replay a write.
    const claimStartedAt = performance.now();
    const claimed = await rpc("threads/nativeCalendarClaim", identifiers, { ...options, signal });
    if (!claimed) continue;
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
}

async function prepareOperation(
  operation: NativeDeviceOperation,
  current: () => boolean,
): Promise<NativeDeviceResponse | { perform(): Promise<NativeDeviceResponse> }> {
  if (isNativeClockOperation(operation)) {
    const { prepareDeviceClock } = await import("../phone-clock/device-clock");
    return prepareDeviceClock(operation, current);
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
