import type { AvatarStyle, Me } from "@rakazo/contracts";
import { usePathname } from "expo-router";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/api";

const AvatarStyleContext = createContext<{
  avatarStyle: AvatarStyle;
  updateAvatarStyle: (avatarStyle: AvatarStyle) => Promise<void>;
}>({
  avatarStyle: "robot",
  updateAvatarStyle: async () => undefined,
});

export function AvatarStyleProvider({ children }: { children: ReactNode }) {
  const [avatarStyle, setAvatarStyle] = useState<AvatarStyle>("robot");
  const pathname = usePathname();
  const requestIdRef = useRef(0);
  const updatePromiseRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    void rpc<Me>("me")
      .then((me) => {
        if (requestId !== requestIdRef.current) return;
        setAvatarStyle(me.avatarStyle);
      })
      .catch(() => undefined);
  }, [pathname]);

  function updateAvatarStyle(next: AvatarStyle): Promise<void> {
    if (updatePromiseRef.current) return updatePromiseRef.current;
    const requestId = ++requestIdRef.current;
    const update = rpc<Me>("preferences/update", { avatarStyle: next })
      .then((me) => {
        if (requestId !== requestIdRef.current) return;
        setAvatarStyle(me.avatarStyle);
      })
      .finally(() => {
        updatePromiseRef.current = null;
      });
    updatePromiseRef.current = update;
    return update;
  }

  return (
    <AvatarStyleContext value={{ avatarStyle, updateAvatarStyle }}>{children}</AvatarStyleContext>
  );
}

export function useAvatarStyle() {
  return useContext(AvatarStyleContext);
}
