import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computer-provider-descriptor.js";
import { raw } from "../../../computer-provider-descriptor.js";

export const e2bComputer: ComputerProviderDefinition = {
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
  env: { e2bApiKey: { name: "E2B_API_KEY", read: raw, required: true } },
  settings: {
    displayName: "E2B",
    fields: [{ key: "apiKey", option: "e2bApiKey", label: "API key", kind: "secret" }],
  },
  async create(opts) {
    const { E2BSandboxProvider } = await import("./e2b-sandbox.js");
    return new E2BSandboxProvider(opts.e2bApiKey!);
  },
};
