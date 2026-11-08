import type { RpcInput, RpcOutput, RpcPath } from "@rakazo/contracts";
import { captureApiRequestContext, rpc } from "./api";
import type { MobileScope } from "./mobile-scope";
import { isMobileScopeCurrent } from "./mobile-scope";
import { currentReadySessionGeneration } from "./session";

/** Pin an implicit Space once before reading or importing a package. */
export async function mobileBotPackageClient(scope: MobileScope, isMounted: () => boolean) {
  const isCurrent = () =>
    isMounted() &&
    isMobileScopeCurrent(scope) &&
    currentReadySessionGeneration() === scope.sessionGeneration;
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("This package editor is no longer current.");
  };
  assertCurrent();
  const context = await captureApiRequestContext(scope.spaceId);
  assertCurrent();
  if (context.apiBase !== scope.apiBase || context.sessionGeneration !== scope.sessionGeneration)
    throw new Error("This package editor is no longer current.");
  const me = await rpc(
    "me",
    {},
    {
      requestContext: { ...context, isCurrent },
      skipSpaceAuthRecovery: true,
    },
  );
  assertCurrent();
  if (!me.userId || !me.spaceId || (scope.spaceId && scope.spaceId !== me.spaceId))
    throw new Error("This package editor is no longer current.");
  const requestContext = {
    ...context,
    isCurrent,
    headers: { ...context.headers, "x-rakazo-space-id": me.spaceId },
  };
  return {
    isCurrent,
    async request<P extends RpcPath>(
      procedure: P,
      input: RpcInput<P>,
      signal?: AbortSignal,
    ): Promise<RpcOutput<P>> {
      assertCurrent();
      signal?.throwIfAborted();
      const value = await rpc(procedure, input, {
        requestContext,
        skipSpaceAuthRecovery: true,
        signal,
      });
      assertCurrent();
      signal?.throwIfAborted();
      return value;
    },
  };
}

export type MobileBotPackageClient = Awaited<ReturnType<typeof mobileBotPackageClient>>;
