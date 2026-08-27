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

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    void rpc<Me>("me")
      .then((me) => {
        if (requestId !== requestIdRef.current) return;
        setAvatarStyle(me.avatarStyle);
      })
      .catch(() => undefined);
  }, [pathname]);

  async function updateAvatarStyle(next: AvatarStyle) {
    const requestId = ++requestIdRef.current;
    const me = await rpc<Me>("preferences/update", { avatarStyle: next });
    if (requestId !== requestIdRef.current) return;
    setAvatarStyle(me.avatarStyle);
  }

  return (
    <AvatarStyleContext value={{ avatarStyle, updateAvatarStyle }}>{children}</AvatarStyleContext>
  );
}

export function useAvatarStyle() {
  return useContext(AvatarStyleContext);
}
