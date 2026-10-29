import type { RpcPath } from "@rakazo/contracts";
import type { RpcArgs } from "./api";
import { captureApiRequestContext, rpc } from "./api";

/** Which copy a settings screen edits: the account's, or one Space's override. */
export type SettingsTarget = { scope: "account" } | { scope: "space"; spaceId: string };

export const ACCOUNT_SETTINGS: SettingsTarget = { scope: "account" };

/** A screen opened with a Space edits that Space's override; without one, the account's. */
export function settingsTarget(spaceId: string | string[] | undefined): SettingsTarget {
  return typeof spaceId === "string" && spaceId ? { scope: "space", spaceId } : ACCOUNT_SETTINGS;
}

/**
 * Calls for a settings screen. A Space override is sent to that Space even when another one is
 * selected, so its settings can be edited from the inbox's Space menu without switching.
 */
export function settingsRpc(target: SettingsTarget): typeof rpc {
  if (target.scope === "account") return rpc;
  const { spaceId } = target;
  return async <P extends RpcPath>(proc: P, ...[body, options]: RpcArgs<P>) => {
    const requestContext = await captureApiRequestContext(spaceId);
    return rpc(proc, ...([body, { ...options, requestContext }] as RpcArgs<P>));
  };
}
