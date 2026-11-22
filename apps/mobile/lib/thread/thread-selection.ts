import { copyableMessagesText } from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
import { BackHandler, Keyboard } from "react-native";
import type { MobileMessage } from "../api/mobile-types";
import { canSelectMessage, selectedMessages, toggleSelected } from "../messages/message-selection";
import { hapticSuccess } from "../native/haptics";

/**
 * The chat's multi-select mode: which messages are chosen (null while not selecting) and the
 * one Copy that puts them on the clipboard together, oldest first.
 */
export function useThreadSelection({
  threadKey,
  focused,
  messages,
}: {
  threadKey: string | undefined;
  focused: boolean;
  messages: readonly MobileMessage[];
}) {
  const [state, setState] = useState<{
    threadKey: string | undefined;
    ids: ReadonlySet<string>;
  } | null>(null);
  // A selection belongs to the chat it was made in.
  const ids = state && state.threadKey === threadKey ? state.ids : null;
  const selecting = ids !== null;
  const chosen = selectedMessages(messages, ids);

  useEffect(() => setState(null), [threadKey]);

  const cancel = useCallback(() => setState(null), []);
  const start = useCallback(
    (message: MobileMessage) => {
      if (!canSelectMessage(message)) return;
      Keyboard.dismiss();
      setState((current) =>
        current && current.threadKey === threadKey
          ? { threadKey, ids: new Set(current.ids).add(message.id) }
          : { threadKey, ids: new Set([message.id]) },
      );
    },
    [threadKey],
  );
  const toggle = useCallback(
    (message: MobileMessage) => {
      if (!canSelectMessage(message)) return;
      setState((current) =>
        current && current.threadKey === threadKey
          ? { threadKey, ids: toggleSelected(current.ids, message.id) }
          : current,
      );
    },
    [threadKey],
  );

  // Only the focused chat answers Back, so a screen opened over it still closes first.
  useEffect(() => {
    if (!selecting || !focused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      cancel();
      return true;
    });
    return () => subscription.remove();
  }, [selecting, focused, cancel]);

  const copy = useCallback(async () => {
    const text = copyableMessagesText(chosen);
    if (!text) return;
    let written = false;
    try {
      written = await Clipboard.setStringAsync(text);
    } catch (error) {
      // Handled with a refusal below: the selection stays, so the person can try again.
      console.warn("Clipboard write failed", error);
    }
    if (!written) return;
    hapticSuccess();
    // Only the selection that was copied ends; one started or changed during the write stays.
    setState((current) => (current?.ids === ids ? null : current));
  }, [chosen, ids]);

  return { ids, count: chosen.length, start, toggle, cancel, copy };
}
