import type { SandboxKindCapabilities } from "@rakazo/adapter-kit";
import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";

export const fakeSandboxCapabilities: SandboxKindCapabilities = {
  terminal: true,
  inPlaceUpdate: true,
  nativeShell: false,
  runsOnUserMachine: false,
  screen: DEFAULT_COMPUTER_SCREEN,
  serverHomeMount: "never",
  serverOwnsStoredTeamHome: false,
  storedHomeIsBackup: false,
};
