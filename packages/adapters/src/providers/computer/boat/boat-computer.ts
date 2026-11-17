import type { ComputerProviderDefinition } from "../../../computers/computer-provider-descriptor.js";

export const boatComputer: ComputerProviderDefinition = {
  capabilities: {
    terminal: true,
    inPlaceUpdate: true,
    nativeShell: false,
    runsOnUserMachine: false,
    screen: { width: 1920, height: 1080 },
    serverHomeMount: "never",
    serverOwnsStoredTeamHome: true,
    storedHomeIsBackup: false,
  },
  env: {
    boatApiKey: { name: "BOAT_API_KEY", required: true },
    boatApiUrl: { name: "BOAT_API_URL" },
  },
  settings: {
    displayName: "Boat",
    fields: [
      { key: "apiKey", option: "boatApiKey", label: "API key", kind: "secret" },
      { key: "apiUrl", option: "boatApiUrl", label: "API URL", kind: "url" },
    ],
  },
  async create(opts) {
    const { BoatSandboxProvider } = await import("./boat-sandbox.js");
    return new BoatSandboxProvider({
      apiKey: opts.boatApiKey!,
      apiUrl: opts.boatApiUrl,
      unreferencedMachines: opts.unreferencedMachines,
    });
  },
};
