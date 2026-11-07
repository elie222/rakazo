import type { PageDetail } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAppForeground } from "./app-foreground";
import { chatOnScreen, getLatestPage, pageReadFailure } from "./pages";

/** Marks the chat back on screen when it refocuses or the app returns, not when it first opens. */
export function useChatOnScreen() {
  const foreground = useAppForeground();
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focused.current) chatOnScreen.mark();
      focused.current = true;
    }, []),
  );
  const wasForeground = useRef(foreground);
  useEffect(() => {
    if (foreground && !wasForeground.current) chatOnScreen.mark();
    wasForeground.current = foreground;
  }, [foreground]);
}

/** A page card's page: from the cache unless a newer version is known or the chat came back. */
export function usePageCardDetail(block: { pageId: string; version: number }) {
  const onScreen = useSyncExternalStore(chatOnScreen.subscribe, chatOnScreen.get);
  const [detail, setDetail] = useState<PageDetail | null | "failed" | "deleted">(null);
  useEffect(() => {
    let active = true;
    void getLatestPage(block.pageId, { atLeastVersion: block.version, since: onScreen }).then(
      (page) => {
        if (active) setDetail(page);
      },
      (error: unknown) => {
        if (active) setDetail(pageReadFailure(error));
      },
    );
    return () => {
      active = false;
    };
  }, [block.pageId, block.version, onScreen]);
  return detail;
}
