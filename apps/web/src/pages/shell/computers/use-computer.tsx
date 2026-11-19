import { useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { ComputerStatus } from "@rakazo/contracts";
import { createScreenReconnects, screenProbeUrl, waitForScreenPage } from "@rakazo/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComputerScreenResult } from "../../../lib/computers/computer-screen";
import {
  createScreenRefocus,
  embeddableScreenUrl,
  isProxiedScreenUrl,
  loadComputerScreen,
  probeScreen,
  probeScreenStatus,
  proxiedScreenCapability,
  SCREEN_FRAME_LOAD_TIMEOUT_MS,
  screenFrameError,
  screenFrameMessage,
  screenFrameStarted,
} from "../../../lib/computers/computer-screen";
import type { createSpaceRpc } from "../../../lib/query/rpc";
import { screenReadLoaded } from "../../../lib/query/thread-events";
import { useEventListener } from "../../../lib/use-event-listener";
import type { Panel } from "../right-panel-state";

// Caps the per-bot computer cache so a long session that opens many distinct bots
// over time doesn't accumulate one entry per bot forever.
const COMPUTER_CACHE_LIMIT = 20;
// How long this tab's own take or release waits for its matching live event.
const OWN_CONTROL_EVENT_MS = 10_000;

type CachedComputer = { computer: ComputerStatus | null; screenUrl: string | null };
/** A screen URL beside what the server said of its sign-in, so the two never drift apart. */
type Screen = Pick<ComputerScreenResult, "url" | "singleUseSignIn">;

/** The computer shown beside the chat or full screen, and its screen. */
export function useComputerState({
  rpc,
  panel,
  activeId,
  activeBotId,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  panel: Panel;
  activeId: string | undefined;
  activeBotId: RefObject<string | undefined>;
}) {
  const { t } = useLingui();
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const computerRef = useRef<ComputerStatus | null>(null);
  // Last-known computer/screen per bot, so switching back to an already-seen
  // bot paints its computer pane instantly instead of blanking it while the
  // thread + screen RPCs round-trip again (see refreshThread / refreshComputerScreen).
  const computerCacheRef = useRef(new Map<string, CachedComputer>());
  // The bot whose boot shows progress, and every bot whose boot request is still out.
  const [bootingBotId, setBootingBotId] = useState<string | null>(null);
  const booting = bootingBotId !== null && bootingBotId === computer?.botId;
  const bootsInFlight = useRef(new Map<string, symbol>());
  // A take or release of control this tab asked for. Its own call reads the new
  // screen, so the matching live event must not start a second read that discards the first.
  const ownControlChange = useRef(
    new Map<
      string,
      {
        botId: string;
        type: string;
        leaseId?: string;
        receivedLeaseId?: string;
        until: number;
        screen?: Promise<unknown>;
        consumed?: boolean;
      }
    >(),
  );
  const ownAnswers = useRef(new Map<string, number>());
  const [screen, setScreen] = useState<Screen>({ url: null });
  const screenUrl = screen.url;
  const screenRef = useRef(screen);
  // A caller holding only a URL shows a cached screen or none; the shown URL keeps its sign-in.
  const setScreenUrl = useCallback(
    (url: string | null) => setScreen((current) => (current.url === url ? current : { url })),
    [],
  );
  const [screenUrlLoadedBotId, setScreenUrlLoadedBotId] = useState<string | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);
  const [computerBotId, setComputerBotId] = useState<string | undefined>();
  const computerOpenRef = useRef(false);
  const computerBotIdRef = useRef<string | undefined>(undefined);
  const [computerViewport, setComputerViewport] = useState<{
    height: number;
    offsetTop: number;
  } | null>(null);
  const [computerError, setComputerError] = useState<string | null>(null);
  // Screen-load failures can sit beside a still-valid embed URL; boot and
  // takeover failures must stay visible even when a URL remains.
  const [computerErrorFromScreen, setComputerErrorFromScreen] = useState(false);
  const computerErrorFromScreenRef = useRef(false);
  computerErrorFromScreenRef.current = computerErrorFromScreen;
  // The framed screen cannot be inspected from here. The proxy says when it refuses the page,
  // and the page reports its own state; nothing past "loading" by the timeout means it stalled.
  const [screenFrame, setScreenFrame] = useState<HTMLIFrameElement | null>(null);
  const [screenLoadError, setScreenLoadError] = useState<string | null>(null);
  // An error that replaced the screen waits for Retry rather than spending another sign-in.
  const screenErrorShown = useRef(false);
  // Synced before the frame's unmount cleanup runs, from committed renders only.
  useLayoutEffect(() => {
    screenRef.current = screen;
    // A screen-read error stays hidden while a frame still shows the screen.
    screenErrorShown.current = Boolean(
      screenLoadError || (computerError && !computerErrorFromScreen),
    );
  });
  const screenFrameReported = useRef(false);
  // A screen that drops after connecting loads again by itself now and then, through the proxy's
  // full check, by remounting its frame.
  // Each bot's screen has its own allowance.
  const screenReconnects = useRef(createScreenReconnects());
  const screenReconnect = () => screenReconnects.current.for(computerBotIdRef.current ?? "");
  const [screenFrameKey, setScreenFrameKey] = useState(0);
  // A new screen of the same bot loads in a new frame while the frame it replaces stays on top,
  // so taking or releasing control never blanks the screen. The held frame goes once the new one
  // reports back.
  const [screenGeneration, setScreenGeneration] = useState(0);
  const [heldScreen, setHeldScreen] = useState<{ url: string; key: string } | null>(null);
  const [shownScreen, setShownScreen] = useState<{ botId?: string; url: string | null }>({
    url: null,
  });
  const frameBotId = computerBotId ?? activeId;
  if (shownScreen.url !== screenUrl || shownScreen.botId !== frameBotId) {
    const before = embeddableScreenUrl(shownScreen.url);
    const after = embeddableScreenUrl(screenUrl);
    const replaced =
      Boolean(screenFrame) &&
      shownScreen.botId === frameBotId &&
      before !== after &&
      proxiedScreenCapability(before) !== null &&
      proxiedScreenCapability(after) !== null;
    // A frame that never connected shows nothing, so an earlier held frame stays instead.
    setHeldScreen(
      replaced
        ? (heldScreen ?? { url: before!, key: `${screenFrameKey}:${screenGeneration}` })
        : null,
    );
    if (replaced) setScreenGeneration((generation) => generation + 1);
    setShownScreen({ botId: frameBotId, url: screenUrl });
  }
  useEffect(() => {
    if (heldScreen && screenLoadError) setHeldScreen(null);
  }, [heldScreen, screenLoadError]);
  useTimeout(
    () => setHeldScreen(null),
    heldScreen && !screenLoadError ? SCREEN_FRAME_LOAD_TIMEOUT_MS : null,
    heldScreen,
  );
  useEffect(() => {
    setHeldScreen(null);
  }, [computerOpen, panel]);
  // The single-use URL a mounted frame signed in with, until its session ends. Reads keep it
  // rather than replace it, since each fresh sign-in ends the frame's session.
  const liveSingleUseUrl = useRef<string | null>(null);
  // A failed single-use screen waits for Retry rather than spending another sign-in.
  const screenAwaitsRetry = useRef(false);
  // Typing goes back into a reconnected screen that had the keyboard when it dropped.
  const screenRefocus = useRef(createScreenRefocus());
  useEffect(() => {
    screenRefocus.current.forget();
  }, [screenUrl, computerOpen]);
  useEffect(() => {
    // Only a mounted frame resets the error: its own failure unmounts it, and Retry remounts it.
    if (!screenFrame) return;
    setScreenLoadError(null);
    screenFrameReported.current = false;
    screenReconnect().loaded();
    const url = embeddableScreenUrl(screenUrl);
    if (!isProxiedScreenUrl(url)) return;
    let cancelled = false;
    void probeScreen(url, t`Could not connect to the computer screen`).then((error) => {
      if (!cancelled && error && !screenFrameReported.current) setScreenLoadError(error);
    });
    return () => {
      cancelled = true;
    };
  }, [screenFrame, screenUrl]);
  // A new frame or screen URL starts the wait again.
  const screenLoad = useMemo(() => ({}), [screenFrame, screenUrl]);
  useTimeout(
    () => {
      if (!screenFrameReported.current)
        setScreenLoadError(t`Could not connect to the computer screen`);
    },
    screenFrame && isProxiedScreenUrl(embeddableScreenUrl(screenUrl))
      ? SCREEN_FRAME_LOAD_TIMEOUT_MS
      : null,
    screenLoad,
  );
  useEffect(() => {
    if (!screenFrame) return;
    const fallback = t`Could not connect to the computer screen`;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let readDeadline: ReturnType<typeof setTimeout> | undefined;
    // One reconnect at a time: while its screen read or page wait is still on its way,
    // further reports of the same drop only describe it again and must not start a second
    // one, whose failure would cancel the first. A new frame or screen URL re-runs this
    // effect and starts the next cycle.
    let reconnectPending = false;
    // The reconnect's screen read left. Only its completion, or its deadline below,
    // releases the hold then, so the drop it answers for still suppresses duplicates
    // while it is out.
    let reconnectReadOut = false;
    // The reconnect the flags and timers belong to; a newer grant supersedes them all.
    let reconnectCycle = 0;
    // Whether the reporting screen is connected, so a read deadline that lands on a
    // reconnected screen leaves it showing instead of replacing it with the error.
    let screenConnected = false;
    const stopped = new AbortController();
    const onMessage = (event: MessageEvent) => {
      if (event.source !== screenFrame.contentWindow) return;
      const message = screenFrameMessage(event.data);
      if (!message) return;
      if (message.rakazoScreen !== "loading" && message.rakazoScreen !== "connecting") {
        setHeldScreen(null);
      }
      if (screenFrameStarted(message)) screenFrameReported.current = true;
      if (message.rakazoScreen === "connected") screenConnected = true;
      else if (message.rakazoScreen === "failed" || message.rakazoScreen === "disconnected")
        screenConnected = false;
      const singleUse = Boolean(screen.singleUseSignIn);
      if (singleUse && message.rakazoScreen === "connected") {
        // The screen page can rejoin by itself, and a fresh read would end that session again.
        clearTimeout(reconnect);
        // A reconnected screen releases a retry it kept queued; a read already out holds
        // until it completes or runs out of time.
        if (!reconnectReadOut) reconnectPending = false;
        liveSingleUseUrl.current = screenUrl;
      }
      if (
        message.rakazoScreen === "connected" &&
        screenRefocus.current.connected(document.activeElement, screenFrame, document.body)
      ) {
        screenFrame.focus();
        screenFrame.contentWindow?.postMessage({ rakazoScreenFocus: true }, "*");
      }
      const ended = message.rakazoScreen === "failed" || message.rakazoScreen === "disconnected";
      if (singleUse && ended) {
        // The sign-in works once, so a dropped session, such as one another viewer took over,
        // comes back only through a fresh read; remounting would replay the spent sign-in.
        // A hidden tab leaves the session to the viewer who took it.
        liveSingleUseUrl.current = null;
        if (
          document.visibilityState === "visible" &&
          screenReconnect().report(message.rakazoScreen) === "reconnect"
        ) {
          if (reconnectPending) return;
          reconnectPending = true;
          reconnectCycle += 1;
          const cycle = reconnectCycle;
          screenRefocus.current.dropped(document.activeElement === screenFrame);
          const botId = computerBotIdRef.current;
          const delay = screenReconnect().delayMs();
          clearTimeout(reconnect);
          reconnect = setTimeout(() => {
            if (!botId || stopped.signal.aborted) {
              reconnectPending = false;
              return;
            }
            reconnectReadOut = true;
            // Claim this read's request token up front, so its deadline can invalidate
            // exactly this read and never a newer one.
            const readRequest = ++screenRequest.current;
            // A read that never settles must not hold the reconnect forever. It gets the
            // same silence budget a framed screen has; past it the hold is released — a
            // dropped screen shows the error, a reconnected one keeps showing — and the
            // hung read's answer is stale, so it cannot commit.
            readDeadline = setTimeout(() => {
              if (cycle !== reconnectCycle) return;
              reconnectPending = false;
              reconnectReadOut = false;
              // A newer read — a takeover, a panel refresh — owns the token now; only this
              // read's own answer is invalidated and shown as timed out.
              if (readRequest !== screenRequest.current) return;
              screenRequest.current += 1;
              if (!screenConnected) {
                screenRefocus.current.forget();
                setScreenLoadError(fallback);
              }
            }, SCREEN_FRAME_LOAD_TIMEOUT_MS);
            void refreshComputerScreen(botId, readRequest).finally(() => {
              if (cycle !== reconnectCycle) return;
              clearTimeout(readDeadline);
              reconnectPending = false;
              reconnectReadOut = false;
            });
          }, delay);
          return;
        }
        screenRefocus.current.forget();
        setScreenLoadError(screenFrameError(message, fallback));
        return;
      }
      if (screenReconnect().report(message.rakazoScreen) === "reconnect") {
        if (reconnectPending) return;
        reconnectPending = true;
        screenRefocus.current.dropped(document.activeElement === screenFrame);
        clearTimeout(reconnect);
        const url = embeddableScreenUrl(screenUrl);
        const delay = screenReconnect().delayMs();
        reconnect = setTimeout(() => {
          // Wait out an API that can't be reached, so the one reconnect isn't spent on it.
          void waitForScreenPage(
            async (signal) =>
              isProxiedScreenUrl(url) ? probeScreenStatus(screenProbeUrl(url), fetch, signal) : 200,
            { signal: stopped.signal },
          ).then((outcome) => {
            if (outcome === "cancelled") return;
            if (outcome === "timeout") {
              screenRefocus.current.forget();
              setScreenLoadError(fallback);
            }
            // A refusal shows once the new frame's own check runs.
            else setScreenFrameKey((key) => key + 1);
          });
        }, delay);
        return;
      }
      const error = screenFrameError(message, fallback);
      if (error) screenRefocus.current.forget();
      setScreenLoadError(error);
    };
    // Moving to anything else in the app (the chat box, say) keeps the keyboard there.
    const onFocusIn = (event: FocusEvent) => {
      if (event.target !== screenFrame) screenRefocus.current.forget();
    };
    window.addEventListener("message", onMessage);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      // Closing the screen or a new screen URL (taking or releasing control) cancels a reconnect.
      stopped.abort();
      clearTimeout(reconnect);
      clearTimeout(readDeadline);
      window.removeEventListener("message", onMessage);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [screenFrame, screenUrl]);
  useEffect(() => {
    // Each single-use frame is keyed by its URL, so it loads exactly one sign-in.
    const { url: frameUrl, singleUseSignIn } = screenRef.current;
    if (!screenFrame || !frameUrl || !singleUseSignIn) return;
    liveSingleUseUrl.current = frameUrl;
    return () => {
      if (liveSingleUseUrl.current === frameUrl) liveSingleUseUrl.current = null;
      // A frame replaced by a fresh sign-in leaves that one alone.
      if (screenRef.current.url !== frameUrl) return;
      setScreenUrl(null);
      if (screenErrorShown.current) {
        screenAwaitsRetry.current = true;
        return;
      }
      // Another frame may still show this computer, such as the panel once the overlay closes.
      const botId = computerBotIdRef.current;
      if (botId && computerVisible.current) {
        setScreenUrlLoadedBotId(null);
        void refreshComputerScreen(botId);
      }
    };
  }, [screenFrame]);
  const viewport = computerOpen ? window.visualViewport : null;
  const syncViewport = () => {
    if (viewport) setComputerViewport({ height: viewport.height, offsetTop: viewport.offsetTop });
  };
  useEffect(() => {
    if (computerOpen) syncViewport();
    else setComputerViewport(null);
  }, [computerOpen]);
  useEventListener(viewport, "resize", syncViewport);
  useEventListener(viewport, "scroll", syncViewport);
  const screenRequest = useRef(0);
  const computerVisible = useRef(false);
  // The bot panel shows the screen too; only the full window keeps the computer awake.
  computerVisible.current = computerOpen || panel === "settings";
  computerOpenRef.current = computerOpen;
  computerBotIdRef.current = computerBotId ?? activeId;

  function cacheComputerFor(botId: string, patch: Partial<CachedComputer>) {
    const cache = computerCacheRef.current;
    const prev = cache.get(botId) ?? { computer: null, screenUrl: null };
    // Re-inserting on every update keeps Map iteration order as least-recently-used first,
    // so eviction drops the bot that's been out of view longest.
    cache.delete(botId);
    cache.set(botId, { ...prev, ...patch });
    if (cache.size > COMPUTER_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  function commitComputer(next: ComputerStatus | null) {
    // A finished screen read stays valid until the computer stops running; control events keep it.
    if (next?.state !== "running") setScreenUrlLoadedBotId(null);
    computerRef.current = next;
    setComputer(next);
  }

  /** Opening a bot paints its last-known computer at once; fresh reads reconcile behind it. */
  function showCachedComputer(botId: string) {
    screenRequest.current += 1;
    screenAwaitsRetry.current = false;
    setScreenUrlLoadedBotId(null);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    const cached = computerCacheRef.current.get(botId);
    if (cached) {
      setScreenUrl(cached.screenUrl);
      commitComputer(cached.computer);
    } else {
      setScreenUrl(null);
    }
  }

  async function refreshComputerScreen(id: string, request?: number) {
    if (!computerVisible.current) return null;
    const read = request ?? ++screenRequest.current;
    const issuedState = computerRef.current?.botId === id ? computerRef.current.state : undefined;
    return loadComputerScreen({
      load: () => rpc.computer.screenUrl({ botId: id, preview: !computerOpenRef.current }),
      isCurrent: () =>
        read === screenRequest.current &&
        (activeBotId.current === id || computerBotIdRef.current === id) &&
        computerVisible.current,
      commit: (answer) => {
        setScreenUrlLoadedBotId(
          computerRef.current?.botId === id &&
            screenReadLoaded(issuedState, computerRef.current.state)
            ? id
            : null,
        );
        setScreen((current) => {
          // A failed single-use screen waits for Retry, and a connected one keeps the sign-in it
          // holds while the server still names the same screen.
          if (
            answer.singleUseSignIn &&
            (screenAwaitsRetry.current ||
              (current.url === liveSingleUseUrl.current &&
                current.singleUseSignIn?.screen === answer.singleUseSignIn.screen))
          )
            return current;
          if (current.url === answer.url) return current;
          return { url: answer.url, singleUseSignIn: answer.singleUseSignIn };
        });
        // A screen read replaces only its own error; a failed boot keeps its error and Retry.
        if (answer.error || computerErrorFromScreenRef.current) {
          setComputerError(answer.error);
          setComputerErrorFromScreen(Boolean(answer.error));
        }
        // A cached single-use URL could only sign in with a spent code.
        cacheComputerFor(id, { screenUrl: answer.singleUseSignIn ? null : answer.url });
      },
      fallbackError: t`Could not connect to the computer screen`,
    });
  }

  /** A known lease narrows the match: a takeover that returned an existing lease sends no event. */
  function expectOwnControlEvent(
    botId: string,
    type: "computer.takeover.granted" | "computer.takeover.released",
    leaseId?: string,
  ) {
    for (const [id, change] of ownControlChange.current) {
      if (Date.now() > change.until) ownControlChange.current.delete(id);
    }
    const pending = ownControlChange.current.get(`${botId}:${type}`);
    const screen =
      leaseId !== undefined && pending?.leaseId === undefined && pending?.type === type
        ? pending.screen
        : undefined;
    ownControlChange.current.set(`${botId}:${type}`, {
      botId,
      type,
      leaseId,
      screen,
      until: Date.now() + OWN_CONTROL_EVENT_MS,
    });
  }

  /** A take or release that failed changed nothing; an event it held back still gets its read. */
  async function forgetOwnControlEvent(botId: string) {
    ownAnswers.current.delete(botId);
    ownControlChange.current.delete(`${botId}:computer.takeover.granted`);
    ownControlChange.current.delete(`${botId}:computer.takeover.released`);
    // Only the bot on screen; another bot's read would discard the shown bot's own read.
    if ((computerBotIdRef.current ?? activeBotId.current) === botId) {
      await refreshComputerScreen(botId).catch(() => undefined);
    }
  }

  /** True once for the live event of a control change this tab asked for. */
  function isOwnControlEvent(botId: string, type: string, leaseId?: unknown) {
    const own = ownControlChange.current.get(`${botId}:${type}`);
    if (type === "computer.takeover.granted")
      ownControlChange.current.delete(`${botId}:computer.takeover.released`);
    if (!own || own.botId !== botId || own.type !== type || Date.now() > own.until) return false;
    if (own.leaseId !== undefined && own.leaseId !== leaseId) return false;
    if (own.consumed) return false;
    if (own.type === "computer.takeover.granted" && own.leaseId === undefined) {
      own.receivedLeaseId = typeof leaseId === "string" ? leaseId : undefined;
      own.consumed = true;
      own.screen ??= refreshComputerScreen(botId).catch(() => null);
      return true;
    }
    ownControlChange.current.delete(`${botId}:${type}`);
    return true;
  }

  function expectOwnAnswer(botId: string) {
    for (const [id, until] of ownAnswers.current) {
      if (Date.now() > until) ownAnswers.current.delete(id);
    }
    ownAnswers.current.set(botId, Date.now() + OWN_CONTROL_EVENT_MS);
  }

  function isOwnAnswer(botId: string) {
    const until = ownAnswers.current.get(botId);
    ownAnswers.current.delete(botId);
    return until !== undefined && Date.now() <= until;
  }

  function ownControlLease(botId: string) {
    const own = ownControlChange.current.get(`${botId}:computer.takeover.granted`);
    return own && Date.now() <= own.until ? (own.leaseId ?? own.receivedLeaseId) : undefined;
  }

  function refreshOwnControlScreen(botId: string) {
    const own = ownControlChange.current.get(`${botId}:computer.takeover.granted`);
    const screen = own && Date.now() <= own.until ? own.screen : undefined;
    if (own) own.screen = undefined;
    return screen ?? refreshComputerScreen(botId);
  }

  /** A retry the user pressed starts the visible screen's reconnects over. */
  function resetScreenReconnect() {
    screenReconnects.current.for(computerBotIdRef.current ?? "").reset();
  }

  return {
    computer,
    computerRef,
    commitComputer,
    computerCacheRef,
    cacheComputerFor,
    showCachedComputer,
    bootingBotId,
    setBootingBotId,
    booting,
    bootsInFlight,
    screenUrl,
    setScreenUrl,
    screenUrlLoadedBotId,
    setScreenUrlLoadedBotId,
    computerOpen,
    setComputerOpen,
    computerBotId,
    setComputerBotId,
    computerOpenRef,
    computerBotIdRef,
    computerViewport,
    computerError,
    setComputerError,
    computerErrorFromScreen,
    setComputerErrorFromScreen,
    setScreenFrame,
    // A fresh single-use sign-in may change only the URL fragment, which would not reload the frame.
    screenFrameKey: screen.singleUseSignIn
      ? `${screenFrameKey}:${screenUrl}`
      : `${screenFrameKey}:${screenGeneration}`,
    heldScreen,
    screenLoadError,
    setScreenLoadError,
    screenAwaitsRetry,
    resetScreenReconnect,
    computerVisible,
    refreshComputerScreen,
    ownControlLease,
    expectOwnAnswer,
    isOwnAnswer,
    refreshOwnControlScreen,
    expectOwnControlEvent,
    forgetOwnControlEvent,
    isOwnControlEvent,
  };
}

export type ComputerState = ReturnType<typeof useComputerState>;

export { useComputerControls } from "./use-computer-controls";
