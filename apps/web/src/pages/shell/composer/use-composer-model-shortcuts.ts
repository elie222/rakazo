import { useCallback, useRef, useState } from "react";

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
  const thinkingStep = useRef<(() => boolean) | null>(null);
  const onThinkingStepChange = useCallback((step: (() => boolean) | null) => {
    thinkingStep.current = step;
  }, []);
  const open = enabled && botId !== undefined && openFor === botId;
  return {
    /** Whether the list is open, so its own chords still reach it past the open-dialog guard. */
    open,
    pickerProps: {
      open,
      onOpenChange: (next: boolean) => setOpenFor(next && botId ? botId : null),
      onThinkingStepChange,
    },
    /** Runs a chord, answering whether it applied. */
    run(shortcut: "model-picker" | "thinking-level") {
      if (!enabled || !botId) return false;
      if (shortcut === "thinking-level") return thinkingStep.current?.() ?? false;
      setOpenFor(open ? null : botId);
      return true;
    },
  };
}
