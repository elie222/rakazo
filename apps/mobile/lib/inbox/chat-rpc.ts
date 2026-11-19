import type { RpcInput, RpcPath } from "@rakazo/contracts";
import type { ApiRequestContext, RpcArgs } from "../api/api";
import { captureApiRequestContext, rpc, selectedSpaceId } from "../api/api";

/** Sends a request about a chat to that chat's space without switching to it. */
async function chatRequestContext(
  spaceId: string | undefined,
): Promise<ApiRequestContext | undefined> {
  if (!spaceId || spaceId === selectedSpaceId()) return undefined;
  const context = await captureApiRequestContext();
  return { ...context, headers: { ...context.headers, "x-rakazo-space-id": spaceId } };
}

export async function chatRpc<P extends RpcPath>(
  spaceId: string | undefined,
  proc: P,
  body: RpcInput<P>,
) {
  const requestContext = await chatRequestContext(spaceId);
  return requestContext
    ? rpc(proc, ...([body, { requestContext, skipSpaceAuthRecovery: true }] as RpcArgs<P>))
    : rpc(proc, ...([body] as RpcArgs<P>));
}
