import { createContext, useContext } from "react";

/** Notifies the enclosing thread message list while an inline card input owns focus. */
export const InlineInputFocusContext = createContext<((focused: boolean) => void) | undefined>(
  undefined,
);

export function useInlineInputFocus() {
  return useContext(InlineInputFocusContext);
}
