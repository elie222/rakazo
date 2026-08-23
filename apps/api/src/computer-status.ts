import type { ComputerStatus } from "@rakazo/contracts";
import { computerScreenSize } from "@rakazo/core";

export function toComputerStatus(
  botId: string,
  computer: {
    kind: string;
    state: string;
    scope: string;
    controlHolder: string;
    controlBotId?: string | null;
    homeRevision: string;
  } | null,
): ComputerStatus {
  const state =
    computer?.state === "suspending"
      ? "running"
      : computer?.state === "stopped" ||
          computer?.state === "booting" ||
          computer?.state === "running" ||
          computer?.state === "suspended" ||
          computer?.state === "error"
        ? computer.state
        : "stopped";
  const screen = computerScreenSize(computer?.kind);
  return {
    botId,
    mode: computer?.scope === "dedicated" ? "dedicated" : "team",
    kind: (computer?.kind ?? "fake") as ComputerStatus["kind"],
    state,
    controlHolder: (computer?.controlHolder ?? "none") as ComputerStatus["controlHolder"],
    controlBotId: computer?.controlBotId ?? null,
    screenAvailable: state === "running" || state === "booting",
    screenWidth: screen.width,
    screenHeight: screen.height,
    homeRevision: computer?.homeRevision ?? null,
    busyBotName: null,
  };
}
