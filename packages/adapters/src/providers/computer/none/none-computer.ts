import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computers/computer-provider-descriptor.js";
import { NoneSandboxProvider } from "./none-sandbox.js";

export const noneComputer: ComputerProviderDefinition = {
  capabilities: {
    terminal: false,
    inPlaceUpdate: false,
    nativeShell: false,
    runsOnUserMachine: false,
    screen: DEFAULT_COMPUTER_SCREEN,
    serverHomeMount: "never",
    serverOwnsStoredTeamHome: false,
    storedHomeIsBackup: false,
  },
  async create() {
    return new NoneSandboxProvider();
  },
};
