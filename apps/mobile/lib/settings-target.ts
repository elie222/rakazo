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
  return async (proc, body, options) =>
    rpc(proc, body, { ...options, requestContext: await captureApiRequestContext(spaceId) });
}
