import { createContext, useContext } from "react";

export const ThreadReadOnlyContext = createContext(false);
export function useThreadReadOnly() {
  return useContext(ThreadReadOnlyContext);
}
