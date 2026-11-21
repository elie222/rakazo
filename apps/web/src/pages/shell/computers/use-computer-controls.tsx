import { Trans, useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { Bot, ComputerReleaseReason, Me, Run, ThreadSnapshot } from "@rakazo/contracts";
import { isComputerAllowanceUsed } from "@rakazo/contracts";
import {
  COMPUTER_CONTROL_HEARTBEAT_MS,
  COMPUTER_HEARTBEAT_MS,
  isRetryableError,
} from "@rakazo/core";
import { Button, Spinner } from "@rakazo/ui-web";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ComputerMaintenanceActions } from "../../../components/computers/ComputerMaintenanceActions";
import { computersAreUnavailable } from "../../../components/computers/ComputersUnavailableHint";
import { runsOnUserMachine } from "../../../lib/computers/computer-sandbox";
import { bootComputerOnce, embeddableScreenUrl } from "../../../lib/computers/computer-screen";
import type { createSpaceRpc } from "../../../lib/query/rpc";
import {
  computerBusyWithRun,
  screenMissing,
  userHoldsComputerControl,
} from "../../../lib/query/thread-events";
import { errorText } from "../../../lib/query/user-error";
import { useEventListener } from "../../../lib/use-event-listener";
import type { Panel } from "../right-panel-state";
import type { ComputerState } from "./use-computer";

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
  onUpgrade,
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
  refreshThread: (
    botId: string,
    signal?: AbortSignal,
    options?: { readScreen?: boolean },
  ) => Promise<ThreadSnapshot>;
  refreshGroupThread: (groupId: string) => Promise<ThreadSnapshot>;
  onUpgrade: () => void;
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
    computerRef,
    computerError,
    setComputerError,
    computerErrorFromScreen,
    setComputerErrorFromScreen,
    screenLoadError,
    setScreenLoadError,
    screenAwaitsRetry,
    resetScreenReconnect,
    computerVisible,
    refreshComputerScreen,
    refreshOwnControlScreen,
    ownControlLease,
    expectOwnAnswer,
    expectOwnControlEvent,
    forgetOwnControlEvent,
  } = state;
  // A new object holds the hint for another four seconds; null lets it go.
  const [recoveryHold, setRecoveryHold] = useState<object | null>(null);
  const showComputerRecoveryHint =
    computersAreUnavailable(sandboxProvider) || recoveryHold !== null;
  const releaseComputerRecovery = useCallback(() => setRecoveryHold(null), []);
  const holdComputerRecovery = useCallback(() => setRecoveryHold({}), []);
  useTimeout(releaseComputerRecovery, recoveryHold ? 4000 : null, recoveryHold);
  useEffect(() => {
    // The recovery hint shows in the bot panel; leaving it lets the hint go.
    if (panel !== "settings") releaseComputerRecovery();
  }, [panel, releaseComputerRecovery]);
  const computerBot =
    (computerBotId ? bots.find((bot) => bot.id === computerBotId) : undefined) ?? active;
  useEffect(() => {
    setScreenLoadError(null);
  }, [computerBot?.id, screenUrl]);
  const computerBootEpoch = useRef(0);
  const controlRequests = useRef(new Set<string>());

  async function bootComputer({
    botId: targetBotId,
    takeControl,
    force = false,
  }: {
    botId: string;
    takeControl: boolean;
    force?: boolean;
  }) {
    if (takeControl && controlRequests.current.has(targetBotId)) return;
    if (takeControl) controlRequests.current.add(targetBotId);
    setScreenUrlLoadedBotId(null);
    screenAwaitsRetry.current = false;
    const epoch = ++computerBootEpoch.current;
    const stillThisBoot = () => computerBootEpoch.current === epoch;
    const stillThisBot = () =>
      computerBotIdRef.current === targetBotId || activeBotId.current === targetBotId;
    const cached = computerCacheRef.current.get(targetBotId);
    const targetComputer = computer?.botId === targetBotId ? computer : (cached?.computer ?? null);
    const targetScreen = computer?.botId === targetBotId ? screenUrl : (cached?.screenUrl ?? null);
    const needsBoot = force || targetComputer?.state !== "running" || !targetScreen;
    if (needsBoot) setBootingBotId(targetBotId);
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
        if (!takeControl) setBootingBotId(null);
      }
      if (takeControl) {
        expectOwnControlEvent(targetBotId, "computer.takeover.granted");
        const { leaseId } = await rpc.computer
          .takeover({ botId: targetBotId })
          .catch(async (error) => {
            await forgetOwnControlEvent(targetBotId);
            throw error;
          });
        expectOwnControlEvent(targetBotId, "computer.takeover.granted", leaseId);
        if (!stillThisBoot() || !stillThisBot()) return;
      }
      await (takeControl
        ? refreshAfterControlChange(targetBotId)
        : refreshComputerFor(targetBotId));
    } catch (error) {
      if (!stillThisBoot() || !stillThisBot()) return;
      setComputerError(
        errorText(error, takeControl ? t`Could not take control` : t`Computer failed to boot`),
      );
      setComputerErrorFromScreen(false);
      throw error;
    } finally {
      if (takeControl) controlRequests.current.delete(targetBotId);
      if (stillThisBoot()) setBootingBotId(null);
    }
  }

  /**
   * After this tab's own take or release, the one screen read starts beside the
   * thread refresh, so a failed refresh still shows the new screen and the live event reads none.
   */
  async function refreshAfterControlChange(targetBotId: string) {
    const shown = activeBotId.current === targetBotId || computerBotIdRef.current === targetBotId;
    const screen = shown ? refreshOwnControlScreen(targetBotId).catch(() => null) : undefined;
    await refreshComputerFor(targetBotId, false).catch(() => undefined);
    await screen;
  }

  async function refreshComputerFor(targetBotId: string, readScreen = true) {
    if (activeBotId.current === targetBotId) {
      await refreshThread(targetBotId, undefined, { readScreen });
      return;
    }
    if (computerBotIdRef.current !== targetBotId) return;
    const status = await rpc.computer.status({ botId: targetBotId });
    if (computerBotIdRef.current !== targetBotId) return;
    commitComputer(status);
    cacheComputerFor(targetBotId, { computer: status });
    if (readScreen) await refreshComputerScreen(targetBotId);
  }

  useEffect(() => {
    setComputerOpen(false);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    setComputerBotId(active?.id);
  }, [active?.id]);

  // Showing the bot panel reads a running computer's screen; it never wakes one.
  const panelScreenBotId =
    panel === "settings" && !computerOpen && computer?.state === "running" && !screenUrl
      ? computer.botId
      : undefined;
  useEffect(() => {
    if (!panelScreenBotId || activeBotId.current !== panelScreenBotId) return;
    if (screenAwaitsRetry.current) return;
    void refreshComputerScreen(panelScreenBotId).catch(() => undefined);
  }, [panelScreenBotId]);

  useEffect(() => {
    if (!computer?.busyBotName) {
      setComputerError(null);
      setComputerErrorFromScreen(false);
    }
  }, [computer?.busyBotName]);

  // Opening the computer while its bot was running was refused as busy; boot it once the run
  // ends, or the open window is left on a stopped computer with nothing to press.
  const computerBlockedByRun = computerBusyWithRun(computer, runStatus);
  useEffect(() => {
    if (computerBlockedByRun) return;
    const botId = computer?.botId;
    if (!botId || !computerOpenRef.current || computerBotIdRef.current !== botId) return;
    if (activeBotId.current !== botId) return;
    if (computer.state !== "stopped" && computer.state !== "suspended") return;
    void bootComputer({
      botId,
      takeControl: false,
      force: true,
    }).catch(() => undefined);
  }, [computerBlockedByRun]);

  useEventListener(computerOpen ? document : null, "keydown", (event) => {
    if (
      event.key === "Escape" &&
      !event.defaultPrevented &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      setComputerOpen(false);
    }
  });

  const hasControl = userHoldsComputerControl(computer, computerBot?.id);
  useEffect(() => {
    const heartbeatBotId = computerBot?.id ?? active?.id;
    if (!computerOpen || !heartbeatBotId || computer?.state !== "running") return;
    // Only a visible page checks in: a forgotten tab neither keeps the computer awake nor holds
    // control, which lapses about a minute and a half after it was hidden.
    const ping = () => {
      if (document.visibilityState !== "visible") return;
      void rpc.computer.heartbeat({ botId: heartbeatBotId }).catch((error) => {
        if (!isRetryableError(error)) window.clearInterval(timer);
      });
    };
    const timer = window.setInterval(
      ping,
      hasControl ? COMPUTER_CONTROL_HEARTBEAT_MS : COMPUTER_HEARTBEAT_MS,
    );
    ping();
    // Coming back checks in at once, so a short visit elsewhere keeps control.
    document.addEventListener("visibilitychange", ping);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", ping);
    };
  }, [computerOpen, computerBot?.id, active?.id, computer?.state, hasControl]);

  // Control ends with the screen: closing it, switching chats, or leaving the page hands it back.
  // The server tells the holder their lease, from Take control or teaching alike; the hand back
  // names it, so a late one from an old page never ends newer control.
  const heldBotId = hasControl && computerOpen ? computerBot?.id : undefined;
  const heldLeaseId = heldBotId ? computer?.controlLeaseId : undefined;
  const handBack = (botId: string, leaseId: string) =>
    void rpc.computer
      .release({ botId, leaseId }, { context: { keepalive: true } })
      .catch(() => undefined);
  useEventListener(heldBotId && heldLeaseId ? window : null, "pagehide", () => {
    if (heldBotId && heldLeaseId) handBack(heldBotId, heldLeaseId);
  });
  useEffect(() => {
    if (!heldBotId || !heldLeaseId) return;
    return () => handBack(heldBotId, heldLeaseId);
  }, [heldBotId, heldLeaseId]);

  // A control event says the screen is held but not by whom; the status read says, and gives the
  // holder their lease. The event, or this tab's own take, already reads the screen.
  const controlBotNeedsRead =
    computer?.controlHolder === "user" && !computer.controlledByOther && !computer.controlLeaseId
      ? computer.botId
      : undefined;
  useEffect(() => {
    if (!controlBotNeedsRead || !computerOpen) return;
    void refreshComputerFor(controlBotNeedsRead, false).catch(() => undefined);
  }, [controlBotNeedsRead, computerOpen]);

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
      setScreenUrl(targetScreen, id);
    }
    // Reopening during a boot shows it; a second boot would be refused as busy.
    const bootInFlight = bootsInFlight.current.has(id) || targetComputer?.state === "booting";
    setComputerOpen(true);
    computerOpenRef.current = true;
    computerVisible.current = true;
    if (bootInFlight && !takeControl) {
      // An external boot may have finished since this snapshot was cached.
      if (!bootsInFlight.current.has(id)) await refreshComputerFor(id).catch(() => undefined);
      return true;
    }
    const needsTakeover = takeControl && !userHoldsComputerControl(targetComputer, id);
    try {
      await bootComputer({
        botId: id,
        takeControl: needsTakeover,
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
  const onOpenComputer = useCallback((botId?: string, takeControl?: boolean) => {
    void openComputerRef.current(botId, takeControl);
  }, []);

  async function releaseComputer(reason?: ComputerReleaseReason) {
    const botId = computerBotIdRef.current ?? activeBotId.current;
    if (!botId) return;
    // Hand back and I'm done end whatever control this person holds on the bot's screen. Nothing
    // changes here until the server answers; the screen then follows its state.
    try {
      const leaseId = computerRef.current?.controlLeaseId ?? ownControlLease(botId);
      if (leaseId) expectOwnControlEvent(botId, "computer.takeover.released", leaseId);
      if (reason !== undefined) expectOwnAnswer(botId);
      await rpc.computer.release({ botId, reason }).catch(async (error) => {
        await forgetOwnControlEvent(botId);
        throw error;
      });
      if (computerBotIdRef.current !== botId && activeBotId.current !== botId) return;
      await refreshAfterControlChange(botId).catch(() => undefined);
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

  /** Answers a needs-you card from the chat; a failure is the card's to show. */
  async function answerTakeover(
    botId: string,
    runId: string | undefined,
    reason: ComputerReleaseReason,
  ) {
    const leaseId =
      computerRef.current?.botId === botId
        ? (computerRef.current.controlLeaseId ?? ownControlLease(botId))
        : ownControlLease(botId);
    if (leaseId) expectOwnControlEvent(botId, "computer.takeover.released", leaseId);
    expectOwnAnswer(botId);
    await rpc.computer.release({ botId, runId, reason }).catch(async (error) => {
      await forgetOwnControlEvent(botId);
      throw error;
    });
    const groupId = activeGroupId.current;
    await Promise.all([
      computerBotIdRef.current === botId || activeBotId.current === botId
        ? refreshAfterControlChange(botId).catch(() => undefined)
        : undefined,
      // A group card may belong to a bot that is neither open nor active.
      groupId ? refreshGroupThread(groupId).catch(() => undefined) : undefined,
    ]);
  }
  const answerTakeoverRef = useRef(answerTakeover);
  answerTakeoverRef.current = answerTakeover;
  const onReleaseComputer = useCallback(
    (botId: string, runId: string | undefined, reason: ComputerReleaseReason) =>
      answerTakeoverRef.current(botId, runId, reason),
    [],
  );

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl);
  const running = computer?.state === "running";
  const frameError = running && !booting ? screenLoadError : null;
  const hideScreenReadError =
    computerErrorFromScreen && (!running || booting || Boolean(embeddedScreenUrl));
  const screenFailure =
    Boolean(frameError) ||
    Boolean(computerError && !hideScreenReadError && computerErrorFromScreen) ||
    screenMissing({
      state: computer?.state,
      runsOnUserMachine: runsOnUserMachine(computer),
      booting,
      screenUrlLoaded: Boolean(computerBot?.id && screenUrlLoadedBotId === computerBot.id),
      embeddedUrl: embeddedScreenUrl,
    });
  const computerFailure =
    computerError && !hideScreenReadError
      ? computerError
      : (frameError ??
        (screenFailure
          ? t`Could not connect to the computer screen`
          : !booting && computer?.state === "error"
            ? t`Computer failed to boot`
            : null));
  // Retrying cannot help once the hours are spent; only a plan change can.
  const allowanceUsed = computer?.state !== "running" && isComputerAllowanceUsed(computerFailure);
  const computerScreenError = computerFailure ? (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 text-center text-body">
      {screenFailure ? (
        <p>
          <Trans>Screen not connected</Trans>
        </p>
      ) : null}
      <p className="text-destructive">{computerFailure}</p>
      {allowanceUsed ? (
        <Button variant="outline" size="sm" onClick={onUpgrade}>
          <Trans>Upgrade</Trans>
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (!computerBot) return;
            setScreenLoadError(null);
            setScreenUrlLoadedBotId(null);
            // An explicit retry clears any error and starts the screen's reconnects over;
            // background screen reads clear only their own error.
            screenAwaitsRetry.current = false;
            resetScreenReconnect();
            if (computer?.state === "running") {
              setComputerError(null);
              setComputerErrorFromScreen(false);
              void refreshComputerScreen(computerBot.id);
            } else
              void bootComputer({
                botId: computerBot.id,
                takeControl: false,
                force: true,
              }).catch(() => undefined);
          }}
        >
          <Trans>Retry screen</Trans>
        </Button>
      )}
      {computerBot &&
      // A screen that will not load on a running computer offers Recover, never a Reset that
      // wipes unsaved work; a failed computer offers whichever repair it has.
      ((screenFailure && computer?.state === "running" && computer.canUpdate) ||
        (computer?.state === "error" && !allowanceUsed)) ? (
        <ComputerMaintenanceActions
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
    !runsOnUserMachine(computer) &&
    computer?.state === "running" &&
    Boolean(embeddedScreenUrl) &&
    !computerScreenError;
  const showingRecoveryHint =
    !computerOpen &&
    !runsOnUserMachine(computer) &&
    !computerPreviewScreen &&
    !computerScreenError &&
    showComputerRecoveryHint;

  return {
    computerBot,
    openComputer,
    onOpenComputer,
    onReleaseComputer,
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
