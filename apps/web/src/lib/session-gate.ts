export interface SessionGateInput {
  data: { user?: unknown } | null | undefined;
  isPending: boolean;
  error: { status?: number } | null;
}

export type SessionGate = "loading" | "unreachable" | "authenticated" | "anonymous";

/**
 * A failed session fetch is not a sign-out. Better Auth keeps the last known
 * session on a network error, but a cold load has nothing to keep, and its
 * refresh manager only polls once a session exists — so a request that fails
 * before the first success never retries. Routing that state to sign-in signs
 * out a user whose cookie is still valid, so it is reported separately.
 */
export function sessionGate(session: SessionGateInput): SessionGate {
  if (session.data?.user) return "authenticated";
  if (session.isPending) return "loading";
  // 401 is the server answering: there is genuinely no session.
  if (session.error && session.error.status !== 401) return "unreachable";
  return "anonymous";
}

/**
 * Better Auth clears `error` and sets `isPending` while a null-session refetch
 * runs, which would otherwise look like a cold "loading" and unmount the
 * reconnect UI (resetting backoff). Hold the unreachable screen across that
 * refetch until the gate resolves to authenticated or anonymous.
 */
export function holdUnreachableGate(gate: SessionGate, holding: boolean): boolean {
  if (gate === "unreachable") return true;
  if (gate === "authenticated" || gate === "anonymous") return false;
  return holding;
}

export function showSessionUnavailable(gate: SessionGate, holding: boolean): boolean {
  return gate === "unreachable" || (holding && gate === "loading");
}

export type SessionReconnectKind = "none" | "blocking" | "banner";

/**
 * Cold loads that never reached the server still need a full-page wait so we
 * do not dump a signed-in cookie onto the sign-in screen. Once the workspace
 * has mounted, keep it and show a reconnect bar — including when Better Auth
 * still holds the last user while a refresh fails.
 */
/** Drop a mounted workspace after a real sign-out so reconnect cannot reuse it. */
export function workspaceMounted(gate: SessionGate, mounted: boolean): boolean {
  if (gate === "authenticated") return true;
  if (gate === "anonymous") return false;
  return mounted;
}

export function sessionReconnectKind(
  session: SessionGateInput,
  holding: boolean,
  sawWorkspace: boolean,
): SessionReconnectKind {
  const gate = sessionGate(session);
  if (gate === "authenticated") {
    return session.error && session.error.status !== 401 ? "banner" : "none";
  }
  if (!showSessionUnavailable(gate, holding)) return "none";
  return sawWorkspace ? "banner" : "blocking";
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 15_000;

/** Exponential backoff for retrying an unreachable session lookup. */
export function sessionRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
}
