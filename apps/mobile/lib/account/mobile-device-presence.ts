import { useTimeout } from "@rakazo/chat-ui/hooks";
import { MOBILE_DEVICE_HEARTBEAT_MS } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging/best-effort";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { captureApiRequestContext, currentApiBase, rpc, subscribeApiBase } from "../api/api";
import { currentReadySessionGeneration, subscribeSessionGeneration } from "../api/session";
import { useAppForeground } from "../platform/app-foreground";

/** A signed-in phone registers even if system notifications are disabled. */
export function MobileDevicePresence({ ready }: { ready: boolean }) {
  const foreground = useAppForeground();
  const session = useSyncExternalStore(subscribeSessionGeneration, currentReadySessionGeneration);
  const server = useSyncExternalStore(subscribeApiBase, currentApiBase);
  const platform = Platform.OS === "android" || Platform.OS === "ios" ? Platform.OS : null;
  const enabled = ready && foreground && platform !== null;
  const [pulse, setPulse] = useState(0);
  const heartbeatKey = JSON.stringify([server, session, pulse]);
  useTimeout(
    () => setPulse((value) => value + 1),
    enabled ? MOBILE_DEVICE_HEARTBEAT_MS : null,
    heartbeatKey,
  );

  useEffect(() => {
    if (!enabled || !platform) return;
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
        if (!controller.signal.aborted) throw error;
      }
    };
    void bestEffort("register mobile device presence", heartbeat());
    return () => controller.abort();
  }, [enabled, heartbeatKey, platform, server, session]);
  return null;
}
