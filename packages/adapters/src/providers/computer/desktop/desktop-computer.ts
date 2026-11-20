import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computers/computer-provider-descriptor.js";
import { HOST_COMPUTER_TRANSFER_MAX_FILE_BYTES } from "../../../computers/host/host-computer-protocol.js";

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
    maxFileBytes: HOST_COMPUTER_TRANSFER_MAX_FILE_BYTES,
  },
  async create(opts) {
    const { assertHostCommandsAllowed, DesktopSandboxProvider } = await import(
      "./desktop-sandbox.js"
    );
    assertHostCommandsAllowed();
    return new DesktopSandboxProvider({ root: opts.dataDir });
  },
};
