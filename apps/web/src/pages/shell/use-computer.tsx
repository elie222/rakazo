import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  ComputerReleaseReason,
  ComputerStatus,
  Me,
  Run,
  ThreadSnapshot,
} from "@rakazo/contracts";
import {
  createScreenReconnects,
  isRetryableError,
  SCREEN_RECONNECT_DELAY_MS,
  SCREEN_RECONNECT_EVERY_MS,
  screenProbeUrl,
  waitForScreenPage,
} from "@rakazo/core";
import { Button, Spinner } from "@rakazo/ui-web";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ComputerMaintenanceActions } from "../../components/ComputerMaintenanceActions";
import { computersAreUnavailable } from "../../components/ComputersUnavailableHint";
import {
  bootComputerOnce,
  createScreenRefocus,
  embeddableScreenUrl,
  isProxiedScreenUrl,
  loadComputerScreen,
  probeScreen,
  probeScreenStatus,
  SCREEN_FRAME_LOAD_TIMEOUT_MS,
  sameWuyingScreen,
  screenFrameError,
  screenFrameMessage,
  screenFrameStarted,
} from "../../lib/computer-screen";
import type { Panel } from "../../lib/right-panel-state";
import type { createSpaceRpc } from "../../lib/rpc";
import {
  computerPanelNeedsScreen,
  computerTakeoverBlocked,
  screenMissing,
  screenReadLoaded,
  userHoldsComputerControl,
} from "../../lib/thread-events";
import { errorText } from "../../lib/user-error";

// Caps the per-bot computer cache so a long session that opens many distinct bots
// over time doesn't accumulate one entry per bot forever.
const COMPUTER_CACHE_LIMIT = 20;

type CachedComputer = { computer: ComputerStatus | null; screenUrl: string | null };

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
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
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
  const screenFrameReported = useRef(false);
  // A screen that drops after connecting loads again by itself now and then, through the proxy's
  // full check, by remounting its frame.
  // Each bot's screen has its own allowance.
  const screenReconnects = useRef(createScreenReconnects());
  const screenReconnect = () => screenReconnects.current.for(computerBotIdRef.current ?? "");
  const [screenFrameKey, setScreenFrameKey] = useState(0);
  // Set once a framed Wuying session ends, so the next read replaces its spent login code.
  const screenSessionEnded = useRef(false);
  const wuyingRetryAt = useRef(0);
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
    const fallback = t`Could not connect to the computer screen`;
    void probeScreen(url, fallback).then((error) => {
      if (!cancelled && error && !screenFrameReported.current) setScreenLoadError(error);
    });
    const timer = setTimeout(() => {
      if (!cancelled && !screenFrameReported.current) setScreenLoadError(fallback);
    }, SCREEN_FRAME_LOAD_TIMEOUT_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [screenFrame, screenUrl]);
  useEffect(() => {
    if (!screenFrame) return;
    const fallback = t`Could not connect to the computer screen`;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const stopped = new AbortController();
    const onMessage = (event: MessageEvent) => {
      if (event.source !== screenFrame.contentWindow) return;
      const message = screenFrameMessage(event.data);
      if (!message) return;
      if (screenFrameStarted(message)) screenFrameReported.current = true;
      if (
        message.rakazoScreen === "connected" &&
        screenRefocus.current.connected(document.activeElement, screenFrame, document.body)
      ) {
        screenFrame.focus();
        screenFrame.contentWindow?.postMessage({ rakazoScreenFocus: true }, "*");
      }
      const ended = message.rakazoScreen === "failed" || message.rakazoScreen === "disconnected";
      if (screenUrl?.startsWith("wuying:") && ended) {
        // A Wuying login code works once, so a frame that loaded a spent one, or a session
        // another viewer took over, can only come back with a fresh read of the screen.
        screenSessionEnded.current = true;
        const now = Date.now();
        if (now - wuyingRetryAt.current >= SCREEN_RECONNECT_EVERY_MS) {
          wuyingRetryAt.current = now;
          const botId = computerBotIdRef.current;
          clearTimeout(reconnect);
          reconnect = setTimeout(() => {
            if (botId && !stopped.signal.aborted) void refreshComputerScreen(botId);
          }, SCREEN_RECONNECT_DELAY_MS);
          return;
        }
      }
      if (screenReconnect().report(message.rakazoScreen) === "reconnect") {
        screenRefocus.current.dropped(document.activeElement === screenFrame);
        clearTimeout(reconnect);
        const url = embeddableScreenUrl(screenUrl);
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
        }, SCREEN_RECONNECT_DELAY_MS);
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
      window.removeEventListener("message", onMessage);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [screenFrame, screenUrl]);
  useEffect(() => {
    if (!computerOpen) {
      setComputerViewport(null);
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => {
      setComputerViewport({ height: viewport.height, offsetTop: viewport.offsetTop });
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
    };
  }, [computerOpen]);
  const screenRequest = useRef(0);
  const computerVisible = useRef(false);
  computerVisible.current = panel === "computer" || computerOpen;
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

  async function refreshComputerScreen(id: string) {
    if (!computerVisible.current) return null;
    const request = ++screenRequest.current;
    const issuedState = computerRef.current?.botId === id ? computerRef.current.state : undefined;
    return loadComputerScreen({
      load: () => rpc.computer.screenUrl({ botId: id }),
      isCurrent: () =>
        request === screenRequest.current &&
        (activeBotId.current === id || computerBotIdRef.current === id) &&
        computerVisible.current,
      commit: (screen) => {
        setScreenUrlLoadedBotId(
          computerRef.current?.botId === id &&
            screenReadLoaded(issuedState, computerRef.current.state)
            ? id
            : null,
        );
        setScreenUrl((current) => {
          if (!screenSessionEnded.current && sameWuyingScreen(current, screen.url)) return current;
          screenSessionEnded.current = false;
          return screen.url;
        });
        // A screen read replaces only its own error; a failed boot keeps its error and Retry.
        if (screen.error || computerErrorFromScreenRef.current) {
          setComputerError(screen.error);
          setComputerErrorFromScreen(Boolean(screen.error));
        }
        cacheComputerFor(id, { screenUrl: screen.url });
      },
      fallbackError: t`Could not connect to the computer screen`,
    });
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
    screenFrameKey,
    screenLoadError,
    setScreenLoadError,
    computerVisible,
    refreshComputerScreen,
  };
}

export type ComputerState = ReturnType<typeof useComputerState>;

/** Booting, opening, taking over and releasing the computer, and what its views show. */
export function useComputerControls({
  rpc,
  state,
  panel,
  active,
  bots,
  botsRef,
  activeBotId,
  activeGroupId,
  runStatus,
  sandboxProvider,
  refreshThread,
  refreshGroupThread,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  state: ComputerState;
  panel: Panel;
  active: Bot | undefined;
  bots: Bot[];
  botsRef: RefObject<Bot[]>;
  activeBotId: RefObject<string | undefined>;
  activeGroupId: RefObject<string | undefined>;
  runStatus: Run["status"] | undefined;
  sandboxProvider: Me["sandboxProvider"] | undefined;
  refreshThread: (botId: string) => Promise<ThreadSnapshot>;
  refreshGroupThread: (groupId: string) => Promise<ThreadSnapshot>;
}) {
  const { t } = useLingui();
  const {
    computer,
    commitComputer,
    computerCacheRef,
    cacheComputerFor,
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
    computerError,
    setComputerError,
    computerErrorFromScreen,
    setComputerErrorFromScreen,
    screenLoadError,
    setScreenLoadError,
    computerVisible,
    refreshComputerScreen,
  } = state;
  const [keepComputerRecovery, setKeepComputerRecovery] = useState(false);
  const recoveryHoldTimer = useRef<number | undefined>(undefined);
  const showComputerRecoveryHint = computersAreUnavailable(sandboxProvider) || keepComputerRecovery;
  const releaseComputerRecovery = useCallback(() => {
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = undefined;
    setKeepComputerRecovery(false);
  }, []);
  const holdComputerRecovery = useCallback(() => {
    setKeepComputerRecovery(true);
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = window.setTimeout(() => {
      recoveryHoldTimer.current = undefined;
      setKeepComputerRecovery(false);
    }, 4000);
  }, []);
  useEffect(() => {
    if (panel !== "computer") releaseComputerRecovery();
  }, [panel, releaseComputerRecovery]);
  useEffect(() => () => window.clearTimeout(recoveryHoldTimer.current), []);
  const computerBot =
    (computerBotId ? bots.find((bot) => bot.id === computerBotId) : undefined) ?? active;
  useEffect(() => {
    setScreenLoadError(null);
  }, [computerBot?.id, screenUrl]);
  const computerBootEpoch = useRef(0);
  const autoBooted = useRef<string | null>(null);

  async function bootComputer({
    botId: targetBotId,
    takeControl,
    showProgress,
    force = false,
  }: {
    botId: string;
    takeControl: boolean;
    showProgress: boolean;
    force?: boolean;
  }) {
    setScreenUrlLoadedBotId(null);
    const epoch = ++computerBootEpoch.current;
    const stillThisBoot = () => computerBootEpoch.current === epoch;
    const stillThisBot = () =>
      computerBotIdRef.current === targetBotId || activeBotId.current === targetBotId;
    const cached = computerCacheRef.current.get(targetBotId);
    const targetComputer = computer?.botId === targetBotId ? computer : (cached?.computer ?? null);
    const targetScreen = computer?.botId === targetBotId ? screenUrl : (cached?.screenUrl ?? null);
    const needsBoot = force || targetComputer?.state !== "running" || !targetScreen;
    if (showProgress && needsBoot) setBootingBotId(targetBotId);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    try {
      if (needsBoot) {
        const status = await bootComputerOnce(bootsInFlight.current, targetBotId, () =>
          rpc.computer.boot({ botId: targetBotId }),
        );
        if (!stillThisBoot() || !stillThisBot()) return;
        if (status) {
          commitComputer(status);
          cacheComputerFor(targetBotId, { computer: status });
        }
      }
      if (takeControl) {
        await rpc.computer.takeover({ botId: targetBotId });
        if (!stillThisBoot() || !stillThisBot()) return;
      }
      await refreshComputerFor(targetBotId);
    } catch (error) {
      if (!stillThisBoot() || !stillThisBot()) return;
      setComputerError(errorText(error, t`Could not take control`));
      setComputerErrorFromScreen(false);
      throw error;
    } finally {
      if (stillThisBoot()) setBootingBotId(null);
    }
  }

  async function refreshComputerFor(targetBotId: string) {
    if (activeBotId.current === targetBotId) {
      await refreshThread(targetBotId);
      return;
    }
    if (computerBotIdRef.current !== targetBotId) return;
    const status = await rpc.computer.status({ botId: targetBotId });
    if (computerBotIdRef.current !== targetBotId) return;
    commitComputer(status);
    cacheComputerFor(targetBotId, { computer: status });
    await refreshComputerScreen(targetBotId);
  }

  useEffect(() => {
    if (panel !== "computer") {
      autoBooted.current = null;
      return;
    }
    if (!active) return;
    const botId = active.id;
    let cancelled = false;
    void (async () => {
      // Refresh from the server first: a stale SSE "booting" snapshot would
      // otherwise hide an RPC takeover.
      const snap = await refreshThread(botId).catch(() => null);
      if (cancelled || activeBotId.current !== botId) return;
      const state = snap?.computer?.state;
      const screen = state === "running" ? await refreshComputerScreen(botId) : null;
      if (cancelled || activeBotId.current !== botId) return;
      if (!computerPanelNeedsScreen(state, screen) || autoBooted.current === botId) return;
      autoBooted.current = botId;
      await bootComputer({
        botId,
        takeControl: false,
        showProgress: false,
        force: true,
      }).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [panel, active?.id]);

  useEffect(() => {
    setComputerOpen(false);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    setComputerBotId(active?.id);
  }, [active?.id]);

  useEffect(() => {
    if (!computer?.busyBotName) {
      setComputerError(null);
      setComputerErrorFromScreen(false);
    }
  }, [computer?.busyBotName]);

  // Opening the computer while its bot was running was refused as busy; boot it once the run
  // ends, or the open window is left on a stopped computer with nothing to press.
  const computerBlockedByRun = computerTakeoverBlocked(computer, runStatus);
  useEffect(() => {
    if (computerBlockedByRun) return;
    const botId = computer?.botId;
    if (!botId || !computerOpenRef.current || computerBotIdRef.current !== botId) return;
    if (activeBotId.current !== botId) return;
    if (computer.state !== "stopped" && computer.state !== "suspended") return;
    void bootComputer({
      botId,
      takeControl: false,
      showProgress: true,
      force: true,
    }).catch(() => undefined);
  }, [computerBlockedByRun]);

  useEffect(() => {
    if (!computerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setComputerOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [computerOpen]);

  useEffect(() => {
    const heartbeatBotId = computerBot?.id ?? active?.id;
    if ((panel !== "computer" && !computerOpen) || !heartbeatBotId || computer?.state !== "running")
      return;
    // A computer panel left open in a hidden window must not keep the computer awake.
    const ping = () => {
      if (document.visibilityState !== "visible") return;
      void rpc.computer.heartbeat({ botId: heartbeatBotId }).catch((error) => {
        if (!isRetryableError(error)) window.clearInterval(timer);
      });
    };
    const timer = window.setInterval(ping, 60_000);
    ping();
    return () => window.clearInterval(timer);
  }, [panel, computerOpen, computerBot?.id, active?.id, computer?.state]);

  /** Open the computer view. Only an explicit Take control asks for the lease. */
  async function openComputer(botId?: string, takeControl = false) {
    const id = botId ?? active?.id;
    if (!id) return false;
    const bot = botsRef.current.find((candidate) => candidate.id === id);
    if (!bot) return false;
    computerBotIdRef.current = id;
    setComputerBotId(id);
    const cached = computerCacheRef.current.get(id);
    const targetComputer = computer?.botId === id ? computer : (cached?.computer ?? null);
    const targetScreen = computer?.botId === id ? screenUrl : (cached?.screenUrl ?? null);
    if (computer?.botId !== id) {
      setScreenUrlLoadedBotId(null);
      commitComputer(targetComputer);
      setScreenUrl(targetScreen);
    }
    // Reopening during a boot shows it; a second boot would be refused as busy.
    const bootInFlight = bootsInFlight.current.has(id) || targetComputer?.state === "booting";
    setComputerOpen(true);
    computerVisible.current = true;
    if (bootInFlight && !takeControl) {
      // An external boot may have finished since this snapshot was cached.
      if (!bootsInFlight.current.has(id)) await refreshComputerFor(id).catch(() => undefined);
      return true;
    }
    const needsTakeover = takeControl && !userHoldsComputerControl(targetComputer, id);
    const blocked = computerTakeoverBlocked(targetComputer, runStatus);
    try {
      await bootComputer({
        botId: id,
        takeControl: needsTakeover && !blocked,
        showProgress: (needsTakeover && !blocked) || targetComputer?.state !== "running",
        force: targetComputer?.state !== "running",
      });
      return true;
    } catch {
      // computerError already set in bootComputer
      return false;
    }
  }
  const openComputerRef = useRef(openComputer);
  openComputerRef.current = openComputer;
  const onOpenComputer = useCallback((botId?: string) => {
    void openComputerRef.current(botId);
  }, []);

  async function releaseComputer(reason?: ComputerReleaseReason) {
    const botId = computerBotIdRef.current ?? activeBotId.current;
    if (!botId) return;
    try {
      await rpc.computer.release({ botId, reason });
      if (computerBotIdRef.current !== botId && activeBotId.current !== botId) return;
      await refreshComputerFor(botId).catch(() => undefined);
      const groupId = activeGroupId.current;
      if (groupId) {
        await refreshGroupThread(groupId).catch(() => undefined);
      }
    } catch {
      if (computerBotIdRef.current !== botId && activeBotId.current !== botId) return;
      setComputerError(t`Could not continue`);
      setComputerErrorFromScreen(false);
    }
  }

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl);
  const hasControl = userHoldsComputerControl(computer, computerBot?.id);
  const hideScreenLoadError = computerErrorFromScreen && Boolean(embeddedScreenUrl);
  const screenFailure =
    Boolean(screenLoadError) ||
    Boolean(computerError && !hideScreenLoadError && computerErrorFromScreen) ||
    screenMissing({
      state: computer?.state,
      kind: computer?.kind,
      booting,
      screenUrlLoaded: Boolean(computerBot?.id && screenUrlLoadedBotId === computerBot.id),
      embeddedUrl: embeddedScreenUrl,
    });
  const computerFailure =
    computerError && !hideScreenLoadError
      ? computerError
      : (screenLoadError ??
        (screenFailure
          ? t`Could not connect to the computer screen`
          : !booting && computer?.state === "error"
            ? t`Computer failed to boot`
            : null));
  const computerScreenError = computerFailure ? (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 text-center text-sm">
      {screenFailure ? (
        <p>
          <Trans>Screen not connected</Trans>
        </p>
      ) : null}
      <p className="text-destructive">{computerFailure}</p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          if (!computerBot) return;
          setScreenLoadError(null);
          setScreenUrlLoadedBotId(null);
          if (computer?.state === "running") {
            // An explicit retry clears any error; background screen reads clear only their own.
            setComputerError(null);
            setComputerErrorFromScreen(false);
            void refreshComputerScreen(computerBot.id);
          } else
            void bootComputer({
              botId: computerBot.id,
              takeControl: false,
              showProgress: true,
              force: true,
            }).catch(() => undefined);
        }}
      >
        <Trans>Retry screen</Trans>
      </Button>
      {screenFailure && computer?.state === "running" && computerBot ? (
        <ComputerMaintenanceActions
          visibleRecover
          botId={computerBot.id}
          computer={computer}
          onChanged={async () => {
            await refreshComputerFor(computerBot.id);
          }}
        />
      ) : null}
    </div>
  ) : null;
  // Booting shows inline with the screen's own Close; leaving it lets the boot finish.
  const computerBooting =
    booting || computer?.state === "booting" ? (
      <span className="flex flex-col items-center gap-3">
        <Spinner aria-hidden className="size-5 motion-reduce:animate-none" />
        {t`Booting live desktop…`}
      </span>
    ) : null;
  const computerPreviewScreen =
    !computerOpen &&
    computer?.kind !== "desktop" &&
    computer?.state === "running" &&
    Boolean(embeddedScreenUrl) &&
    !computerScreenError;
  const showingRecoveryHint =
    !computerOpen &&
    computer?.kind !== "desktop" &&
    !computerPreviewScreen &&
    !computerScreenError &&
    showComputerRecoveryHint;

  return {
    computerBot,
    openComputer,
    onOpenComputer,
    releaseComputer,
    refreshComputerFor,
    holdComputerRecovery,
    releaseComputerRecovery,
    showComputerRecoveryHint,
    showingRecoveryHint,
    embeddedScreenUrl,
    hasControl,
    computerScreenError,
    computerBooting,
  };
}
