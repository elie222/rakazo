import { useLingui } from "@lingui/react/macro";
import { useMemo, useRef, useState } from "react";
import { rpc } from "./api";
import type { ComputerStatus } from "./computer";
import { COMPUTER_LIFECYCLE_TIMEOUT_MS, readScreenUrl, SCREEN_URL_OPEN_ATTEMPTS } from "./computer";
import { createComputerRefresh } from "./computer-refresh";
import { computerBootErrorDetail, errorText } from "./user-error";

/** A bot's computer status and screen link, kept fresh, and the boot that starts it. */
export function useComputerBoot(botId: string | undefined) {
  /** The lease this screen took for each bot, so a late hand back never ends newer control. */
  const takenLeases = useRef(new Map<string, string>());
  const { t } = useLingui();
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readyBotId, setReadyBotId] = useState<string | null>(null);
  const [bootingCount, setBootingCount] = useState(0);
  const booting = bootingCount > 0;
  const [bootFailed, setBootFailed] = useState(false);

  const refreshController = useMemo(
    () =>
      createComputerRefresh({
        readStatus: () => rpc("computer/status", { botId: botId ?? "" }),
        readScreen: (attempts) =>
          readScreenUrl(() => rpc("computer/screenUrl", { botId: botId ?? "" }), {
            attempts,
          }),
        onStatus: (status) => {
          setComputer(status);
          // Another client may have started it since this one failed.
          if (status.state === "running") setBootFailed(false);
        },
        onScreen: setScreenUrl,
        onReady: () => setReadyBotId(botId ?? null),
        onInitialError: (err) => setError(errorText(err)),
      }),
    [botId],
  );

  async function bootComputer({
    takeControl,
    showProgress,
    force = false,
  }: {
    takeControl: boolean;
    showProgress: boolean;
    force?: boolean;
  }) {
    if (!botId || !refreshController.isActive()) return false;
    const action = refreshController.beginAction();
    const needsBoot = force || computer?.state !== "running" || !screenUrl;
    let starting = needsBoot;
    const showBooting = showProgress && needsBoot;
    if (showBooting) {
      setBootingCount((count) => count + 1);
      setError(null);
    }
    setBootFailed(false);
    try {
      if (needsBoot) {
        const answered = await rpc(
          "computer/boot",
          { botId },
          { timeoutMs: COMPUTER_LIFECYCLE_TIMEOUT_MS },
        ).then(
          () => true,
          (err: unknown) => {
            // The server keeps booting after the client stops waiting; the status poll takes over.
            if (err instanceof Error && err.name === "TimeoutError") return false;
            throw err;
          },
        );
        if (!answered) return false;
      }
      starting = false;
      if (!action.isActive()) return false;
      if (takeControl) {
        const takeover = () => rpc("computer/takeover", { botId });
        // The server may have granted control after the app stopped waiting. Asking again returns
        // that same lease to its holder, so the screen can hand it back when it closes.
        const taken = await takeover().catch((err: unknown) => {
          if (err instanceof Error && err.name === "TimeoutError") return takeover();
          throw err;
        });
        takenLeases.current.set(botId, taken.leaseId);
      }
      if (!action.isActive()) return false;
      await action.refresh({ screenAttempts: SCREEN_URL_OPEN_ATTEMPTS });
      if (!action.isActive()) return false;
      setError(null);
      return true;
    } catch (err) {
      if (!action.isActive()) return false;
      setError(
        starting
          ? computerBootErrorDetail(err)
          : err instanceof Error && err.name === "TimeoutError"
            ? t`Request timed out`
            : errorText(err, t`Could not open computer`),
      );
      setBootFailed(starting);
      throw err;
    } finally {
      if (action.isActive() && showBooting) setBootingCount((count) => count - 1);
      action.finish();
    }
  }

  return {
    computer,
    setComputer,
    screenUrl,
    setScreenUrl,
    error,
    setError,
    readyBotId,
    setReadyBotId,
    booting,
    setBootingCount,
    bootFailed,
    setBootFailed,
    refreshController,
    bootComputer,
    takenLeases,
  };
}
