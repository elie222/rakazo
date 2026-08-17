import type { AppBootstrap } from "@rakazo/contracts";
import { markOnce } from "./performance";
import { rpc } from "./rpc";

let primedBootstrap: { botId?: string; promise: Promise<AppBootstrap> } | null = null;

if (window.location.pathname === "/app" || window.location.pathname.startsWith("/app/")) {
  const botId = botIdFromPath(window.location.pathname);
  const promise = requestBootstrap(botId);
  // Authentication can redirect before Shell consumes this speculative request.
  // Register a rejection handler immediately while preserving rejection for a consumer.
  void promise.catch(() => undefined);
  primedBootstrap = { botId, promise };
}

export function takeInitialBootstrap(botId?: string) {
  const primed = primedBootstrap;
  primedBootstrap = null;
  if (primed && primed.botId === botId) return primed.promise;
  return requestBootstrap(botId);
}

function requestBootstrap(botId?: string) {
  markOnce("rk:renderer:bootstrap-request-start");
  return rpc.bootstrap(botId ? { botId } : {}).then((bootstrap) => {
    markOnce("rk:renderer:bootstrap-response");
    return bootstrap;
  });
}

function botIdFromPath(pathname: string) {
  const encoded = pathname.split("/")[2];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}
