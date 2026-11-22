import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computers/computer-provider-descriptor.js";
import { raw } from "../../../computers/computer-provider-descriptor.js";

export const railwayComputer: ComputerProviderDefinition = {
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
    railwayApiToken: { name: "RAILWAY_API_TOKEN", read: raw, required: true },
    railwayEnvironmentId: { name: "RAILWAY_ENVIRONMENT_ID", read: raw, required: true },
    railwayMaxWorkspaceFileBytes: { name: "RAILWAY_MAX_WORKSPACE_FILE_BYTES", read: raw },
    railwaySandboxRegion: { name: "RAILWAY_SANDBOX_REGION" },
  },
  settings: {
    displayName: "Railway",
    fields: [
      { key: "apiToken", option: "railwayApiToken", label: "API token", kind: "secret" },
      {
        key: "environmentId",
        option: "railwayEnvironmentId",
        label: "Environment ID",
        kind: "text",
      },
      { key: "region", option: "railwaySandboxRegion", label: "Region", kind: "text" },
    ],
  },
  async create(opts) {
    const { RailwaySandboxProvider } = await import("./railway-sandbox.js");
    return new RailwaySandboxProvider({
      token: opts.railwayApiToken!,
      environmentId: opts.railwayEnvironmentId!,
      maxWorkspaceFileBytes: opts.railwayMaxWorkspaceFileBytes,
      region: opts.railwaySandboxRegion,
      unreferencedMachines: opts.unreferencedMachines,
    });
  },
};
