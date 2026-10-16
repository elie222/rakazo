import type { AvatarStyle, Me } from "@rakazo/contracts";
import { usePathname } from "expo-router";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { rpc } from "../lib/api";
import { createAvatarStyleClient, getCachedAvatarStyle } from "../lib/avatar-style";
import { currentSessionGeneration, saveAvatarStyleIfCurrent } from "../lib/session";

const AvatarStyleContext = createContext<{
  avatarStyle: AvatarStyle;
  updateAvatarStyle: (avatarStyle: AvatarStyle) => Promise<void>;
}>({
  avatarStyle: "organic",
  updateAvatarStyle: async () => undefined,
});

export function AvatarStyleProvider({ children }: { children: ReactNode }) {
  const [avatarStyle, setAvatarStyle] = useState<AvatarStyle>(getCachedAvatarStyle);
  const pathname = usePathname();
  const clientRef = useRef<ReturnType<typeof createAvatarStyleClient> | null>(null);
  if (!clientRef.current) {
    clientRef.current = createAvatarStyleClient({
      read: async () => (await rpc<Me>("me")).avatarStyle,
      write: async (style) =>
        (await rpc<Me>("preferences/update", { avatarStyle: style })).avatarStyle,
      publish: setAvatarStyle,
      generation: currentSessionGeneration,
      save: saveAvatarStyleIfCurrent,
    });
  }
  const client = clientRef.current;

  useEffect(() => {
    client.refresh();
    // A launch or route change while offline keeps the cached style; resuming refetches it.
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") client.refresh();
    });
    return () => appState.remove();
  }, [client, pathname]);

  return (
    <AvatarStyleContext value={{ avatarStyle, updateAvatarStyle: client.update }}>
      {children}
    </AvatarStyleContext>
  );
}

export function useAvatarStyle() {
  return useContext(AvatarStyleContext);
}
