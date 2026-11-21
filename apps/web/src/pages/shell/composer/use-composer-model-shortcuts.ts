import { useCallback, useRef, useState } from "react";
import type { ComposerModelKeys } from "./composer-model-picker";

/**
 * Cmd/Ctrl+Shift+M and Cmd/Ctrl+Shift+E for the model beside Send: the first opens and closes its
 * list, the second steps its thinking. `botId` is the chat whose model shows, and `enabled` is
 * whether its button can be used right now.
 */
export function useComposerModelShortcuts({
  botId,
  enabled,
}: {
  botId: string | undefined;
  enabled: boolean;
}) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  // Another chat starts with its list closed, and coming back does not reopen this one.
  const [shownBot, setShownBot] = useState(botId);
  if (shownBot !== botId) {
    setShownBot(botId);
    setOpenFor(null);
  }
  // Set while the picker is shown and usable; a picker that goes away forgets an open list.
  const keys = useRef<ComposerModelKeys | null>(null);
  const onKeysChange = useCallback((next: ComposerModelKeys | null) => {
    keys.current = next;
    if (!next) setOpenFor(null);
  }, []);
  const open = enabled && botId !== undefined && openFor === botId;
  return {
    /** Whether the list is open, so its own chords still reach it past the open-dialog guard. */
    open,
    pickerProps: {
      open,
      onOpenChange: (next: boolean) => setOpenFor(next && botId ? botId : null),
      onKeysChange,
    },
    /** Runs a chord, answering whether it applied. */
    run(shortcut: "model-picker" | "thinking-level") {
      const picker = keys.current;
      if (!enabled || !botId || !picker) return false;
      if (shortcut === "thinking-level") return picker.stepThinking();
      if (open) setOpenFor(null);
      else if (picker.canOpen()) setOpenFor(botId);
      else return false;
      return true;
    },
  };
}
