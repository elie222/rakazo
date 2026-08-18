import type { ComputerMode } from "@rakazo/contracts";

export const COMPUTER_HEARTBEAT_MS = 60_000;

export type ComputerStatus = {
  state: string;
  controlHolder: string;
  controlBotId: string | null;
  screenAvailable: boolean;
  mode: ComputerMode;
  busyBotName: string | null;
};

function isLocalHostname(hostname: string) {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/** Point a loopback noVNC URL at the same host the app uses for the API. */
export function embeddableScreenUrl(url: string | null, apiBase: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const api = new URL(apiBase);
    if (isLocalHostname(parsed.hostname) && !isLocalHostname(api.hostname)) {
      parsed.hostname = api.hostname;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function previewPlaceholder(
  state: string | undefined,
  booting: boolean,
  name: string,
  mode?: ComputerMode,
): string {
  if (state === "booting" || booting) return "Booting live desktop…";
  if (state === "running") return computerLabel(mode, name);
  if (state === "suspended") return "Computer is asleep — take control to wake it";
  if (state === "error") return "Computer failed to boot";
  return "Computer is stopped";
}

export function controlLabel(computer: ComputerStatus | null, name: string, botId?: string) {
  if (computer?.busyBotName) return `${computer.busyBotName} is using it`;
  if (computer?.controlHolder === "user" && computer.controlBotId === botId) {
    return "You have control";
  }
  if (computer?.state === "suspended") return "Asleep";
  return computerLabel(computer?.mode, name);
}

export function computerLabel(mode: ComputerMode | undefined, name: string) {
  return mode === "dedicated" ? `${name}’s computer` : "Team Computer";
}
