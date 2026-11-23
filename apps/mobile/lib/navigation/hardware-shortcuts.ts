import { resolveChatNavigationShortcut } from "@rakazo/core";
import { requireOptionalNativeModule } from "expo-modules-core";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { loadSessionToken } from "../api/session";

type EscapeAction = "modal" | "thread";
type ShortcutEvent = { key: string; presented: boolean };
type HardwareShortcutModule = {
  setThreadEscapeEnabled?(enabled: boolean): void;
  addListener(event: "onShortcut", listener: (event: ShortcutEvent) => void): { remove(): void };
};

function hardwareShortcutModule() {
  return requireOptionalNativeModule<HardwareShortcutModule>("RakazoComposerKeyboard");
}

const escapeActions: Record<EscapeAction, Set<() => void>> = {
  modal: new Set(),
  thread: new Set(),
};

export function useHardwareEscape(kind: EscapeAction, action: (() => void) | null) {
  const latest = useRef(action);
  useLayoutEffect(() => {
    latest.current = action;
  }, [action]);
  const enabled = action !== null;
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      const run = () => latest.current?.();
      const handlers = escapeActions[kind];
      handlers.add(run);
      if (kind === "thread") hardwareShortcutModule()?.setThreadEscapeEnabled?.(true);
      return () => {
        handlers.delete(run);
        if (kind === "thread" && !handlers.size) {
          hardwareShortcutModule()?.setThreadEscapeEnabled?.(false);
        }
      };
    }, [enabled, kind]),
  );
}

export function useHardwareShortcuts(ready: boolean, session: number) {
  const router = useRouter();
  const [signedInSession, setSignedInSession] = useState<number | null>(null);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    void loadSessionToken().then((token) => {
      if (active) setSignedInSession(token ? session : null);
    });
    return () => {
      active = false;
    };
  }, [ready, session]);
  const enabled = ready && signedInSession === session;
  const handle = useEffectEvent(({ key, presented }: ShortcutEvent) => {
    if (!enabled) return;
    if (key === "Escape") {
      const layer = presented ? "modal" : "thread";
      [...escapeActions[layer]].at(-1)?.();
      return;
    }
    switch (resolveChatNavigationShortcut({ key, metaKey: true })) {
      case "search":
        router.navigate("/search");
        break;
      case "new-chat":
        router.navigate("/new-group");
        break;
    }
  });
  useEffect(() => {
    if (!enabled) return;
    const subscription = hardwareShortcutModule()?.addListener("onShortcut", (event) =>
      handle(event),
    );
    return () => subscription?.remove();
  }, [enabled]);
}
