import type { SandboxTypeEnum } from "@boatdev/sdk";
import type { ComputerSize } from "@rakazo/contracts";
import type { ComputerProviderDefinition } from "../../../computers/computer-provider-descriptor.js";

export const BOAT_MACHINE_TYPES: Record<ComputerSize, SandboxTypeEnum> = {
  standard: "default",
  large: "large",
  xlarge: "xlarge",
};

export function boatComputerSize(
  type: SandboxTypeEnum | null | undefined,
): ComputerSize | undefined {
  return type === "default" ? "standard" : type === "large" || type === "xlarge" ? type : undefined;
}

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
    readStoppedFiles: true,
    sizedUsage: true,
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
