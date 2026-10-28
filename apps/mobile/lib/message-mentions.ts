import type { ReactNode } from "react";
import { createContext } from "react";

/** Draws the bots a reply announces where its text names them. */
export const MessageMentionsContext = createContext<((id: string) => ReactNode) | undefined>(
  undefined,
);
