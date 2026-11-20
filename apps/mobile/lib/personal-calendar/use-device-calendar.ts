import type { CalendarResponse, NativeCalendarRequest } from "@rakazo/contracts";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { captureApiRequestContext, currentApiBase, rpc, selectedSpaceId } from "../api/api";
import { useSpaceChanges } from "../api/roster-signals";
import { currentSessionGeneration } from "../api/session";
import { useAppActive } from "../platform/app-foreground";
import { reportMobileError } from "../platform/monitoring";
import { nativeCalendarDeviceKey } from "./device-calendar-key";

let presenting = false;
let queuedRead: (() => void) | undefined;

export function useDeviceCalendar(botId: string | undefined, focused: boolean) {
  const active = useAppActive();
  const enabled = Boolean(botId && focused && nativeCalendarDeviceKey());
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
  const deviceKey = nativeCalendarDeviceKey();
  if (!deviceKey) return;
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
  // Charge the full request round trip against each server-reported budget.
  // This keeps the device's wall clock out of permission and write decisions.
  const pendingStartedAt = performance.now();
  const pending = await rpc(
    "threads/nativeCalendarPending",
    { botId, deviceKey },
    { ...options, signal },
  );
  for (const request of pending) {
    if (!current()) return;
    const active = () => current() && performance.now() - pendingStartedAt < request.remainingMs;
    if (!active()) continue;
    const identifiers = { ...requestIds(request), deviceKey };
    const { prepareDeviceCalendar, validateDeviceCalendarResult } = await import(
      "./device-calendar"
    );
    const prepared = await prepareDeviceCalendar(request.operation, active).catch(
      (error: unknown) => {
        reportMobileError(new Error("Device calendar preparation failed"), "rpc.transport", {
          errorType: error instanceof Error ? error.name : "unknown",
        });
        return { status: "unavailable" as const };
      },
    );
    if (!current()) return;
    if (!active()) continue;

    // Confirm first. The server issues the single-use claim only while the run and
    // its original owner/device still match. Losing this response cannot replay a write.
    const claimStartedAt = performance.now();
    const claimed = await rpc("threads/nativeCalendarClaim", identifiers, { ...options, signal });
    if (!claimed) continue;
    let response: CalendarResponse;
    if (!current() || performance.now() - claimStartedAt >= claimed.remainingMs)
      response = { status: "unavailable" };
    else if ("status" in prepared) response = prepared;
    else {
      try {
        response = validateDeviceCalendarResult(claimed.operation, await prepared.perform());
      } catch (error) {
        reportMobileError(new Error("Device calendar execution failed"), "rpc.transport", {
          errorType: error instanceof Error ? error.name : "unknown",
        });
        const write = !claimed.operation.action.startsWith("list_");
        response = { status: write ? "uncertain" : "unavailable" };
      }
    }
    if (sameSession())
      await rpc("threads/nativeCalendarResult", { ...identifiers, response }, options);
  }
}

function requestIds({ id, runId, threadId }: NativeCalendarRequest) {
  return { id, runId, threadId };
}
