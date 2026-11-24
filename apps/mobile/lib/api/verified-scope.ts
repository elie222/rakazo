import { t } from "@lingui/core/macro";
import type { Me } from "@rakazo/contracts";
import { currentApiBase, rpc, selectedSpaceId } from "./api";
import { currentSessionGeneration, saveVerifiedScope } from "./session";

/**
 * Who the server says is signed in, and which Space a selection resolves to, for this session.
 * Disk copies (saved chats, saved reads) are filed under it, never under the session generation,
 * which starts again at every launch.
 */
export type VerifiedScope = {
  apiBase: string;
  userId: string;
  spaceId: string;
  sessionGeneration: number;
  selectionId: string | null;
};

// Reuse verified identity within this session, never across sign-out or server changes.
let identity:
  | {
      apiBase: string;
      generation: number;
      selectionId: string | null;
      user: Promise<Pick<Me, "userId" | "spaceId">>;
    }
  | undefined;

/** Asks the server who is signed in, once per session and selected Space. */
export async function verifiedScope(): Promise<VerifiedScope> {
  const apiBase = currentApiBase();
  const generation = currentSessionGeneration();
  const spaceId = selectedSpaceId();
  if (
    !identity ||
    identity.apiBase !== apiBase ||
    identity.generation !== generation ||
    identity.selectionId !== spaceId
  ) {
    const user = rpc("me");
    const entry = { apiBase, generation, selectionId: spaceId, user };
    identity = entry;
    void user.catch(() => {
      if (identity === entry) identity = undefined;
    });
  }
  const me = await identity.user;
  if (
    apiBase !== currentApiBase() ||
    generation !== currentSessionGeneration() ||
    spaceId !== selectedSpaceId()
  )
    throw new Error(t`Something went wrong. Try again.`);
  if (!me.userId || !(spaceId || me.spaceId)) throw new Error(t`Something went wrong. Try again.`);
  const scope = {
    apiBase,
    userId: me.userId,
    spaceId: spaceId || me.spaceId,
    sessionGeneration: generation,
    selectionId: spaceId,
  };
  void saveVerifiedScope(generation, scope);
  return scope;
}

/**
 * The Space a selection names, or, with none selected, the one the verified identity says the
 * server chose when it saw no selection either. Null when that is unknown.
 */
export function verifiedSpaceId(
  selectionId: string | null,
  verified: { spaceId: string; selectionId: string | null } | null,
): string | null {
  return selectionId ?? (verified?.selectionId === null ? verified.spaceId : null);
}

/** Whether the selected Space and the session are still the ones of this moment. */
export function captureSessionScope(): () => boolean {
  const spaceId = selectedSpaceId();
  const generation = currentSessionGeneration();
  return () => selectedSpaceId() === spaceId && currentSessionGeneration() === generation;
}

export function isVerifiedScopeCurrent(scope: VerifiedScope): boolean {
  return (
    scope.apiBase === currentApiBase() &&
    scope.sessionGeneration === currentSessionGeneration() &&
    scope.selectionId === selectedSpaceId()
  );
}
