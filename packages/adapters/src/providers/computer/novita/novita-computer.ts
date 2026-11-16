import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computer-provider-descriptor.js";

export const novitaComputer: ComputerProviderDefinition = {
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
    novitaApiKey: { name: "NOVITA_API_KEY", required: true },
    sandboxTemplate: { name: "SANDBOX_TEMPLATE" },
  },
  settings: {
    displayName: "Novita",
    fields: [
      { key: "apiKey", option: "novitaApiKey", label: "API key", kind: "secret" },
      { key: "template", option: "sandboxTemplate", label: "Template", kind: "text" },
    ],
  },
  async create(opts) {
    const { NovitaSandboxProvider } = await import("./novita-sandbox.js");
    return new NovitaSandboxProvider({
      apiKey: opts.novitaApiKey!,
      template: opts.sandboxTemplate,
      onUnsafeStop: opts.onUnsafeStop,
    });
  },
};
