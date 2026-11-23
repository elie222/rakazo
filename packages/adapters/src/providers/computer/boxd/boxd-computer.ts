import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computers/computer-provider-descriptor.js";

export const boxdComputer: ComputerProviderDefinition = {
  capabilities: {
    terminal: true,
    inPlaceUpdate: true,
    nativeShell: false,
    runsOnUserMachine: false,
    screen: DEFAULT_COMPUTER_SCREEN,
    serverHomeMount: "never",
    serverOwnsStoredTeamHome: true,
    storedHomeIsBackup: false,
  },
  env: {
    boxdApiKey: { name: "BOXD_API_KEY", required: true },
    boxdOrg: { name: "BOXD_ORG" },
  },
  settings: {
    displayName: "Boxd",
    fields: [
      { key: "apiKey", option: "boxdApiKey", label: "API key", kind: "secret" },
      { key: "org", option: "boxdOrg", label: "Organization", kind: "text" },
    ],
  },
  async create(opts) {
    const { createBoxdSandboxProvider } = await import("./boxd-sandbox.js");
    return createBoxdSandboxProvider({
      apiKey: opts.boxdApiKey!,
      org: opts.boxdOrg,
      unreferencedMachines: opts.unreferencedMachines,
    });
  },
};
