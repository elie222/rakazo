import type { SandboxKindCapabilities } from "@rakazo/adapter-kit";
import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";

export const instaboxSandboxCapabilities: SandboxKindCapabilities = {
  terminal: true,
  inPlaceUpdate: true,
  nativeShell: false,
  runsOnUserMachine: false,
  screen: DEFAULT_COMPUTER_SCREEN,
  serverHomeMount: "never",
  serverOwnsStoredTeamHome: true,
  storedHomeIsBackup: false,
};
