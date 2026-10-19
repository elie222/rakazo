import type { AppBootstrap } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES, attachmentMaxBytes } from "@rakazo/contracts";
import { initialBootstrapTarget } from "./bootstrap-target";
import { markOnce } from "./performance";
import { rpc, selectedSpaceId } from "./rpc";

let ticketBoardEnabled = false;
let maxUploadSizeBytes = ATTACHMENT_MAX_BYTES;
export function getMaxUploadSizeBytes() {
  return maxUploadSizeBytes;
}
const capabilityListeners = new Set<() => void>();
export function getTicketBoardEnabled() {
  return ticketBoardEnabled;
}
export function subscribeTicketBoardEnabled(listener: () => void) {
  capabilityListeners.add(listener);
  return () => {
    capabilityListeners.delete(listener);
  };
}

let primedBootstrap: {
  botId?: string;
  spaceId?: string;
  promise: Promise<AppBootstrap>;
} | null = null;

const initialTarget = initialBootstrapTarget(
  window.location.pathname,
  Boolean(window.rakazoDesktop),
);
if (initialTarget) {
  const { botId } = initialTarget;
  const promise = requestBootstrap(botId);
  // Authentication can redirect before Shell consumes this speculative request.
  // Register a rejection handler immediately while preserving rejection for a consumer.
  void promise.catch(() => undefined);
  primedBootstrap = { botId, promise };
}

/** The speculative first-load bootstrap, left in place for the shell to take. */
export function peekInitialBootstrap(): Promise<AppBootstrap> | undefined {
  // Only the speculative first load may be shared with the subscription gate.
  return primedBootstrap?.spaceId === undefined ? primedBootstrap?.promise : undefined;
}

export function takeInitialBootstrap(botId?: string) {
  const primed = primedBootstrap;
  primedBootstrap = null;
  if (
    primed &&
    primed.botId === botId &&
    (primed.spaceId === undefined || primed.spaceId === selectedSpaceId())
  ) {
    return primed.spaceId === undefined ? primed.promise : primed.promise.then(applyCapabilities);
  }
  return requestBootstrap(botId);
}

/**
 * Loads another space's bootstrap without selecting that space, and leaves it
 * for the shell to take once the space is selected. Rejects on failure so the
 * caller can fall back to a full reload.
 */
export function primeSpaceBootstrap(spaceId: string, botId?: string): Promise<AppBootstrap> {
  const promise = requestBootstrap(botId, spaceId);
  void promise.catch(() => undefined);
  primedBootstrap = { botId, spaceId, promise };
  return promise;
}

/** Drops a primed bootstrap nobody will take, so a later shell cannot take another space's. */
export function discardPrimedBootstrap(promise: Promise<AppBootstrap>): void {
  if (primedBootstrap?.promise === promise) primedBootstrap = null;
}

function requestBootstrap(botId?: string, spaceId?: string) {
  markOnce("rk:renderer:bootstrap-request-start");
  const input = botId ? { botId } : {};
  const request = spaceId ? rpc.bootstrap(input, { context: { spaceId } }) : rpc.bootstrap(input);
  return request.then((bootstrap) => {
    markOnce("rk:renderer:bootstrap-response");
    return spaceId === undefined ? applyCapabilities(bootstrap) : bootstrap;
  });
}

function applyCapabilities(bootstrap: AppBootstrap): AppBootstrap {
  ticketBoardEnabled = bootstrap.me.ticketBoardEnabled;
  maxUploadSizeBytes = attachmentMaxBytes(bootstrap.me);
  for (const listener of capabilityListeners) listener();
  return bootstrap;
}
