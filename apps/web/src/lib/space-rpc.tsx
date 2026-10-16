import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";
import type { RpcClient } from "./rpc";
import { rpc, rpcForSpace } from "./rpc";

type SpaceRpc = { client: RpcClient; spaceId: string | null };

const SpaceRpcContext = createContext<SpaceRpc>({ client: rpc, spaceId: null });

/** Points the settings panels below at one space's data. */
export function SpaceRpcProvider({
  spaceId,
  children,
}: {
  spaceId: string | null | undefined;
  children: ReactNode;
}) {
  const value = useMemo<SpaceRpc>(
    () => (spaceId ? { client: rpcForSpace(spaceId), spaceId } : { client: rpc, spaceId: null }),
    [spaceId],
  );
  return <SpaceRpcContext.Provider value={value}>{children}</SpaceRpcContext.Provider>;
}

/** The rpc client for the space these settings act on. */
export function useSpaceRpc(): RpcClient {
  return useContext(SpaceRpcContext).client;
}

/** The space settings are bound to, or null when they follow the selected space. */
export function useBoundSpaceId(): string | null {
  return useContext(SpaceRpcContext).spaceId;
}
