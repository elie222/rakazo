import { useEffect, useState } from "react";
import { rpc } from "./api";
import type { ComputerStatus } from "./computer";
import { COMPUTER_HEARTBEAT_MS } from "./computer";

/** Whether a computer status means the bot is operating the computer right now. */
export function isComputerRunning(status: ComputerStatus | null | undefined): boolean {
  return status?.state === "running";
}

/**
 * Whether this bot's computer is running, checked on mount and on the computer heartbeat.
 * A status that cannot be read counts as not running, so the entry never shows without one.
 */
export function useComputerRunning(botId: string | undefined): boolean {
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!botId) {
      setRunning(false);
      return;
    }
    let cancelled = false;
    const check = () => {
      void rpc("computer/status", { botId })
        .then((status) => {
          if (!cancelled) setRunning(isComputerRunning(status));
        })
        .catch(() => {
          if (!cancelled) setRunning(false);
        });
    };
    check();
    const timer = setInterval(check, COMPUTER_HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [botId]);
  return running;
}
