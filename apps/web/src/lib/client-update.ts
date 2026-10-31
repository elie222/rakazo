import {
  CLIENT_UPDATE_REQUIRED_STATUS,
  compareBuilds,
  SERVER_BUILD_HEADER,
} from "@rakazo/contracts";
import { getSnapshot as activeCall } from "./call-session";
import { CLIENT_BUILD } from "./client-build";
import { composerHoldsUnsavedWork, hasUnsentComposerDraft } from "./composer-draft";
import { hasOpenDialog } from "./has-open-dialog";
import { recoveryReload } from "./preload-recovery";
import { onRpcResponse } from "./rpc";

const ATTEMPT_KEY = "rk:client-update-attempt";
/** No keys, pointer, or scrolling for this long counts as idle. */
export const CLIENT_UPDATE_IDLE_MS = 5 * 60_000;
/** Ask the web server at most this often whether it already serves the newer build. */
export const CLIENT_UPDATE_CHECK_SPACING_MS = 30_000;
/** A refused tab re-checks the served build each minute for this many minutes (a rollout). */
export const CLIENT_UPDATE_REQUIRED_RETRIES = 10;
const INPUT_EVENTS = ["keydown", "pointerdown", "input", "wheel", "touchstart"] as const;

type Moment = "hidden" | "navigation" | "idle";

export type ClientUpdateDeps = {
  build: string;
  document: Pick<Document, "visibilityState" | "activeElement" | "querySelector">;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  listen: (type: string, listener: () => void) => () => void;
  /** Every API reply. */
  responses: (listener: (response: Response) => void) => () => void;
  /** The build the web server serves right now, from `/build-id`. */
  servedBuild: () => Promise<string | null>;
  /** The shared recovery reload; false when its loop guard refused. */
  reload: () => boolean;
  /** Work a reload would lose at any moment: a call, a send in flight, attachments in memory. */
  holdsUnsavedWork: () => boolean;
  /** Also saved-but-unsent text, which blocks only the idle reload. */
  hasUnsentDraft: () => boolean;
  now: () => number;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

/**
 * Moves an open tab onto a newer deployment without interrupting anyone. API replies name the
 * deployed build; once it is newer than this bundle, the tab reloads at the first safe moment —
 * hidden, navigating, or idle with nothing unsent — and only after the web server confirms it
 * already serves a newer build, which it may not yet mid-deploy. A refused client (426) reloads at
 * once; drafts live in local storage and survive it.
 *
 * Loops are impossible by construction: every reload records the build it left and the build it
 * expected, and a tab that comes back on the same build never reloads for that target again (a
 * desktop app's bundled renderer, or a cache that served the old page). The shared recovery guard
 * also allows at most one automatic reload per cooldown.
 */
export function createClientUpdates(deps: ClientUpdateDeps) {
  let target: string | null = null;
  let lastInput = deps.now();
  let lastCheck = Number.NEGATIVE_INFINITY;
  let checking = false;
  let requiredRetries = 0;

  const attempted = (build: string): boolean => {
    try {
      const saved: unknown = JSON.parse(deps.storage?.getItem(ATTEMPT_KEY) ?? "null");
      if (!saved || typeof saved !== "object") return false;
      const { from, to } = saved as { from?: unknown; to?: unknown };
      return from === deps.build && (compareBuilds(to, build) ?? -1) >= 0;
    } catch {
      return false;
    }
  };
  const newer = (build: string | null | undefined): build is string =>
    (compareBuilds(deps.build, build) ?? 0) < 0;

  const editing = (): boolean => {
    const element = deps.document.activeElement as
      | (Element & { value?: unknown; isContentEditable?: boolean })
      | null;
    if (!element) return false;
    if (typeof element.value === "string") return element.value !== "";
    return Boolean(element.isContentEditable && element.textContent);
  };
  const safe = (moment: Moment): boolean => {
    if (editing() || deps.holdsUnsavedWork()) return false;
    if (hasOpenDialog(deps.document)) {
      return false;
    }
    if (moment !== "idle") return true;
    return deps.now() - lastInput >= CLIENT_UPDATE_IDLE_MS && !deps.hasUnsentDraft();
  };

  const remember = (value: string | null) => {
    try {
      if (value === null) deps.storage?.removeItem(ATTEMPT_KEY);
      else deps.storage?.setItem(ATTEMPT_KEY, value);
    } catch {
      // Without session storage the recovery guard still bounds reloads to one per cooldown.
    }
  };

  /**
   * Reload only onto a build the server already serves, and only once per build pair. A soft
   * update re-checks that the moment is still safe after the fetch; a refused build (`moment`
   * null) reloads regardless.
   */
  const reloadOntoServedBuild = async (moment: Moment | null): Promise<boolean> => {
    checking = true;
    lastCheck = deps.now();
    try {
      const served = await deps.servedBuild().catch(() => null);
      if (!newer(served) || attempted(served)) return false;
      if (moment && !safe(moment)) return false;
      let previous: string | null = null;
      try {
        previous = deps.storage?.getItem(ATTEMPT_KEY) ?? null;
      } catch {
        // Nothing to restore.
      }
      remember(JSON.stringify({ from: deps.build, to: served }));
      if (deps.reload()) return true;
      // The recovery guard refused (offline, or cooling down): this pair was never tried.
      remember(previous);
      return false;
    } finally {
      checking = false;
    }
  };

  const tryAt = (moment: Moment) => {
    if (!target || checking || !safe(moment)) return;
    if (deps.now() - lastCheck < CLIENT_UPDATE_CHECK_SPACING_MS) return;
    void reloadOntoServedBuild(moment);
  };

  const updates = {
    /** Every API reply names the deployed build. */
    noteServerBuild(build: string | null | undefined) {
      if (!newer(build) || attempted(build)) return;
      if (target && (compareBuilds(target, build) ?? 0) >= 0) return;
      target = build;
      if (deps.document.visibilityState === "hidden") tryAt("hidden");
    },
    /**
     * The server refused this build: reload now, whatever the user is doing. Mid-rollout the web
     * server may still serve this build, so keep checking each minute for a while.
     */
    updateRequired() {
      if (!deps.build) return;
      requiredRetries = CLIENT_UPDATE_REQUIRED_RETRIES;
      if (!checking) void reloadOntoServedBuild(null);
    },
    navigated() {
      tryAt("navigation");
    },
    install(): () => void {
      if (!deps.build) return () => {};
      const noteInput = () => {
        lastInput = deps.now();
      };
      const stops = [
        deps.responses((response) => {
          if (response.status === CLIENT_UPDATE_REQUIRED_STATUS) updates.updateRequired();
          else updates.noteServerBuild(response.headers.get(SERVER_BUILD_HEADER));
        }),
        ...INPUT_EVENTS.map((type) => deps.listen(type, noteInput)),
        deps.listen("visibilitychange", () => {
          if (deps.document.visibilityState === "hidden") tryAt("hidden");
        }),
      ];
      const idle = deps.setInterval(() => {
        if (requiredRetries > 0 && !checking) {
          requiredRetries--;
          void reloadOntoServedBuild(null);
        } else tryAt("idle");
      }, 60_000);
      return () => {
        for (const stop of stops) stop();
        deps.clearInterval(idle);
      };
    },
  };
  return updates;
}

let shared: ReturnType<typeof createClientUpdates> | undefined;

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The tab's one update tracker. */
export function clientUpdates(): ReturnType<typeof createClientUpdates> {
  shared ??= createClientUpdates({
    build: typeof window === "undefined" ? "" : CLIENT_BUILD,
    document: globalThis.document,
    storage: typeof window === "undefined" ? null : sessionStorageOrNull(),
    listen: (type, listener) => {
      const target = type === "visibilitychange" ? document : window;
      target.addEventListener(type, listener, { capture: true, passive: true });
      return () => target.removeEventListener(type, listener, { capture: true });
    },
    responses: onRpcResponse,
    servedBuild: async () => {
      const response = await fetch("/build-id", { cache: "no-store", credentials: "omit" });
      return response.ok ? (await response.text()).trim() : null;
    },
    reload: recoveryReload,
    holdsUnsavedWork: () => activeCall() !== null || composerHoldsUnsavedWork(),
    hasUnsentDraft: () => hasUnsentComposerDraft(),
    now: () => Date.now(),
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
  });
  return shared;
}
