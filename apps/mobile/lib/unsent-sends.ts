import { t } from "@lingui/core/macro";
import { isModelRequiredSendError } from "@rakazo/core";
import { Alert, AppState } from "react-native";
import type { RpcArgs } from "./api";
import {
  captureApiRequestContext,
  currentApiBase,
  isServerReachable,
  passwordChangeInFlight,
  rpc,
  selectedSpaceId,
  subscribeServerReachable,
} from "./api";
import { artifactCacheSession } from "./artifact-cache-session";
import { integrationsCacheScope } from "./integrations-cache";
import { askToAddModel } from "./model-settings";
import { outboxDisk } from "./outbox-disk";
import {
  currentReadySessionGeneration,
  currentSessionGeneration,
  loadSessionToken,
  loadVerifiedIntegrationsScope,
  snapshotSessionToken,
  subscribeSessionGeneration,
} from "./session";
import type { OutboxScope } from "./thread-feedback";
import {
  configureUnsentSends,
  hasUnsentSends,
  restoreUnsentSends,
  sendWaitingMessages,
  unsentSendsReadable,
} from "./thread-feedback";
import { errorText } from "./user-error";

let activeScope: (OutboxScope & { generation: number }) | null = null;
function scope() {
  return activeScope &&
    activeScope.generation === currentSessionGeneration() &&
    activeScope.apiBase === currentApiBase()
    ? activeScope
    : null;
}
async function loadUnsentSends(): Promise<void> {
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const spaceId = selectedSpaceId();
  if (!scope() || activeScope?.spaceId !== spaceId) {
    const saved = await loadVerifiedIntegrationsScope();
    const verified =
      saved?.apiBase === apiBase && (spaceId || saved.selectionId === null)
        ? saved
        : await integrationsCacheScope();
    const cacheSession = await artifactCacheSession(await loadSessionToken());
    if (
      generation !== currentSessionGeneration() ||
      apiBase !== currentApiBase() ||
      spaceId !== selectedSpaceId()
    )
      throw new Error(t`Failed to send message`);
    activeScope = {
      apiBase,
      spaceId: spaceId ?? verified.spaceId,
      userId: verified.userId,
      cacheSession,
      generation,
    };
  }
  restoreUnsentSends();
}

/** The latest restore attempt, never rejected: false when it could not load the queue. */
let restoreAttempt: Promise<boolean> = Promise.resolve(true);

/**
 * Waits for the latest queue restore, following any attempt that replaces it meanwhile, so a
 * not-yet-loaded queue cannot look empty. False means the queue on disk is unknown. Judged
 * when asked, because clearing the queue with the session makes it known again.
 */
export async function unsentSendsRestored(): Promise<boolean> {
  for (;;) {
    const attempt = restoreAttempt;
    const loaded = await attempt;
    if (attempt !== restoreAttempt) continue;
    // A restore that could not read the saved queue leaves it unknown, not empty.
    if (!unsentSendsReadable()) return false;
    if (loaded) return true;
    // Signed out, the queue was cleared with the session, so a failed restore hides nothing.
    const signedOut = await snapshotSessionToken().then(
      (session) => session.ok && !session.value,
      () => false,
    );
    if (attempt === restoreAttempt) return signedOut;
  }
}

export function prepareUnsentSends(): Promise<void> {
  const attempt = loadUnsentSends();
  restoreAttempt = attempt.then(
    () => true,
    () => false,
  );
  return attempt;
}
// Configure the wipe before bootstrap can replace credentials or the saved server.
configureUnsentSends({
  request: async (proc, body, options, spaceId) => {
    const generation = currentSessionGeneration();
    const context = await captureApiRequestContext();
    if (generation !== currentSessionGeneration()) throw new Error("Session changed");
    const headers = { ...context.headers };
    if (spaceId) headers["x-rakazo-space-id"] = spaceId;
    else delete headers["x-rakazo-space-id"];
    return rpc(
      proc,
      ...([body, { ...options, requestContext: { ...context, headers } }] as RpcArgs<typeof proc>),
    );
  },
  serverReachable: isServerReachable,
  passwordChanging: passwordChangeInFlight,
  scope,
  disk: outboxDisk,
  errorText: (error) => errorText(error, t`Failed to send message`),
  notDelivered: (attempt) => {
    if (isModelRequiredSendError(attempt.error)) {
      askToAddModel();
    } else if (!attempt.imageConfirmation) {
      Alert.alert(t`Failed to send message`, attempt.error);
    }
  },
});
export function startUnsentSends(): () => void {
  let stopped = false;
  const retry = (force = false) =>
    void prepareUnsentSends()
      .then(() => {
        if (!stopped) return sendWaitingMessages(force);
      })
      .catch(() => undefined);
  retry();
  const reachable = subscribeServerReachable(() => {
    if (isServerReachable()) retry();
  });
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") retry(true);
  });
  // Other session changes empty the queue; a password change keeps it for the new session.
  const session = subscribeSessionGeneration(() => {
    if (currentReadySessionGeneration() !== currentSessionGeneration()) return;
    if (hasUnsentSends()) retry();
    // A ready session restores again, so a failure from a signed-out launch does not linger.
    else void prepareUnsentSends().catch(() => undefined);
  });
  return () => {
    stopped = true;
    reachable();
    appState.remove();
    session();
  };
}
