import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computer-provider-descriptor.js";

export const desktopComputer: ComputerProviderDefinition = {
  capabilities: {
    terminal: false,
    inPlaceUpdate: false,
    nativeShell: true,
    runsOnUserMachine: true,
    screen: DEFAULT_COMPUTER_SCREEN,
    serverHomeMount: "never",
    serverOwnsStoredTeamHome: false,
    storedHomeIsBackup: true,
  },
  async create(opts) {
    const { assertHostCommandsAllowed, DesktopSandboxProvider } = await import(
      "./desktop-sandbox.js"
    );
    assertHostCommandsAllowed();
    return new DesktopSandboxProvider({ root: opts.dataDir });
  },
};
