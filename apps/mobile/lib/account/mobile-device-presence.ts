import { useTimeout } from "@rakazo/chat-ui/hooks";
import { MOBILE_DEVICE_HEARTBEAT_MS } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging/best-effort";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { captureApiRequestContext, currentApiBase, rpc, subscribeApiBase } from "../api/api";
import { currentReadySessionGeneration, subscribeSessionGeneration } from "../api/session";
import { useAppForeground } from "../platform/app-foreground";
import { MobileDeviceRoutesUnavailable } from "./mobile-device-errors";

const OLDER_SERVER_RECHECK_MS = 10 * MOBILE_DEVICE_HEARTBEAT_MS;

/** A signed-in phone registers even if system notifications are disabled. */
export function MobileDevicePresence({ ready }: { ready: boolean }) {
  const foreground = useAppForeground();
  const session = useSyncExternalStore(subscribeSessionGeneration, currentReadySessionGeneration);
  const server = useSyncExternalStore(subscribeApiBase, currentApiBase);
  const platform = Platform.OS === "android" || Platform.OS === "ios" ? Platform.OS : null;
  const enabled = ready && foreground && platform !== null;
  const [pulse, setPulse] = useState(0);
  const accountKey = JSON.stringify([server, session]);
  const heartbeatKey = JSON.stringify([accountKey, pulse]);
  const backoff = useRef<{ accountKey: string; until: number } | null>(null);
  useTimeout(
    () => setPulse((value) => value + 1),
    enabled ? MOBILE_DEVICE_HEARTBEAT_MS : null,
    heartbeatKey,
  );

  useEffect(() => {
    if (!enabled || !platform) return;
    if (backoff.current?.accountKey === accountKey && backoff.current.until > Date.now()) return;
    const controller = new AbortController();
    const heartbeat = async () => {
      try {
        const requestContext = await captureApiRequestContext(null);
        if (
          controller.signal.aborted ||
          !requestContext.headers.authorization ||
          requestContext.apiBase !== server ||
          requestContext.sessionGeneration !== session
        )
          return;
        await rpc(
          "mobileDevices/heartbeat",
          { platform },
          { requestContext, signal: controller.signal, skipSpaceAuthRecovery: true },
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!(error instanceof MobileDeviceRoutesUnavailable)) throw error;
        // Avoid failed heartbeats on an old server, but discover in-place upgrades.
        backoff.current = { accountKey, until: Date.now() + OLDER_SERVER_RECHECK_MS };
      }
    };
    void bestEffort("register mobile device presence", heartbeat());
    return () => controller.abort();
  }, [accountKey, enabled, heartbeatKey, platform, server, session]);
  return null;
}
