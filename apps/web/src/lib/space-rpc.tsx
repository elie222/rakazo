import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";
import type { RpcClient } from "./rpc";
import { createSpaceRpc, rpc, rpcForSpace } from "./rpc";

type SpaceRpc = { client: RpcClient; spaceId: string | null | undefined };

const SpaceRpcContext = createContext<SpaceRpc>({ client: rpc, spaceId: undefined });

/** Binds components below to a space, or lets them follow the selected space. */
export function SpaceRpcProvider({
  spaceId,
  children,
}: {
  spaceId: string | null | undefined;
  children: ReactNode;
}) {
  const value = useMemo<SpaceRpc>(
    () =>
      spaceId === undefined
        ? { client: rpc, spaceId }
        : { client: spaceId === null ? createSpaceRpc(null) : rpcForSpace(spaceId), spaceId },
    [spaceId],
  );
  return <SpaceRpcContext.Provider value={value}>{children}</SpaceRpcContext.Provider>;
}

/** The rpc client for the space these settings act on. */
export function useSpaceRpc(): RpcClient {
  return useContext(SpaceRpcContext).client;
}

/** The bound space, or undefined when components follow the selected space. */
export function useBoundSpaceId(): string | null | undefined {
  return useContext(SpaceRpcContext).spaceId;
}
