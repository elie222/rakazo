import type { SandboxKindCapabilities } from "@rakazo/adapter-kit";
import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";

export const desktopSandboxCapabilities: SandboxKindCapabilities = {
  terminal: false,
  inPlaceUpdate: false,
  nativeShell: true,
  runsOnUserMachine: true,
  screen: DEFAULT_COMPUTER_SCREEN,
  serverHomeMount: "never",
  serverOwnsStoredTeamHome: false,
  storedHomeIsBackup: true,
};
