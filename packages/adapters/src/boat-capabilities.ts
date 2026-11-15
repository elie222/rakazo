import type { SandboxKindCapabilities } from "@rakazo/adapter-kit";

export const boatSandboxCapabilities: SandboxKindCapabilities = {
  terminal: true,
  inPlaceUpdate: true,
  nativeShell: false,
  runsOnUserMachine: false,
  screen: { width: 1920, height: 1080 },
  serverHomeMount: "never",
  serverOwnsStoredTeamHome: true,
  storedHomeIsBackup: false,
};
