import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computers/computer-provider-descriptor.js";

export const instaboxComputer: ComputerProviderDefinition = {
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
  env: { instaboxApiKey: { name: "INSTABOX_API_KEY", required: true } },
  settings: {
    displayName: "InstaBox",
    fields: [{ key: "apiKey", option: "instaboxApiKey", label: "API key", kind: "secret" }],
  },
  async create(opts) {
    const { InstaboxSandboxProvider } = await import("./instabox-sandbox.js");
    return new InstaboxSandboxProvider({
      apiKey: opts.instaboxApiKey!,
      onUnsafeStop: opts.onUnsafeStop,
      unreferencedMachines: opts.unreferencedMachines,
    });
  },
};
