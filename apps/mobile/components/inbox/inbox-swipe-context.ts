import type { RefObject } from "react";
import { createContext } from "react";

export type OpenSwipe = { id: string; close: () => void };

/** The inbox and its activity rows share one open swipe. */
export const InboxSwipeContext = createContext<RefObject<OpenSwipe | null> | null>(null);
