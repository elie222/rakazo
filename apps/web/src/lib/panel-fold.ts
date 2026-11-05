import { createContext, useContext, useMemo, useState } from "react";

/**
 * Whether the open bot panel is folded away because the window is too narrow, and a way to
 * bring it back over the thread. The panel reports its state; the shell's toggle reads it.
 */
export type PanelFold = {
  folded: boolean;
  setFolded: (folded: boolean) => void;
  /** Bumps when the user asks to see a folded panel. */
  unfoldRequest: number;
  requestUnfold: () => void;
};

export const PanelFoldContext = createContext<PanelFold | null>(null);

export function usePanelFoldState(): PanelFold {
  const [folded, setFolded] = useState(false);
  const [unfoldRequest, setUnfoldRequest] = useState(0);
  return useMemo(
    () => ({
      folded,
      setFolded,
      unfoldRequest,
      requestUnfold: () => setUnfoldRequest((request) => request + 1),
    }),
    [folded, unfoldRequest],
  );
}

export function usePanelFold() {
  return useContext(PanelFoldContext);
}
