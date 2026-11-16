import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computer-provider-descriptor.js";
import { raw } from "../../../computer-provider-descriptor.js";

export const daytonaComputer: ComputerProviderDefinition = {
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
    daytonaApiKey: { name: "DAYTONA_API_KEY", read: raw, required: true },
    daytonaApiUrl: { name: "DAYTONA_API_URL", read: raw },
    daytonaTarget: { name: "DAYTONA_TARGET", read: raw },
  },
  settings: {
    displayName: "Daytona",
    fields: [
      { key: "apiKey", option: "daytonaApiKey", label: "API key", kind: "secret" },
      { key: "apiUrl", option: "daytonaApiUrl", label: "API URL", kind: "url" },
      { key: "target", option: "daytonaTarget", label: "Target", kind: "text" },
    ],
  },
  async create(opts) {
    const { createDaytonaSandboxProvider } = await import("./daytona-sandbox.js");
    return createDaytonaSandboxProvider({
      apiKey: opts.daytonaApiKey!,
      apiUrl: opts.daytonaApiUrl,
      target: opts.daytonaTarget,
      unreferencedMachines: opts.unreferencedMachines,
    });
  },
};
