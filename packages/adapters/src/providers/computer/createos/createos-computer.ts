import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computer-provider-descriptor.js";
import { raw } from "../../../computer-provider-descriptor.js";

export const createosComputer: ComputerProviderDefinition = {
  capabilities: {
    terminal: false,
    inPlaceUpdate: true,
    nativeShell: false,
    runsOnUserMachine: false,
    screen: DEFAULT_COMPUTER_SCREEN,
    serverHomeMount: "never",
    serverOwnsStoredTeamHome: true,
    storedHomeIsBackup: false,
  },
  env: {
    createosApiKey: { name: "CREATEOS_SANDBOX_API_KEY", read: raw, required: true },
    createosBaseUrl: { name: "CREATEOS_SANDBOX_BASE_URL", read: raw },
    createosShape: { name: "CREATEOS_SANDBOX_SHAPE", read: raw },
    createosRootfs: { name: "CREATEOS_SANDBOX_ROOTFS", read: raw },
  },
  settings: {
    displayName: "CreateOS",
    fields: [
      { key: "apiKey", option: "createosApiKey", label: "API key", kind: "secret" },
      { key: "baseUrl", option: "createosBaseUrl", label: "API URL", kind: "url" },
      { key: "shape", option: "createosShape", label: "Shape", kind: "text" },
      { key: "rootfs", option: "createosRootfs", label: "Root filesystem", kind: "text" },
    ],
  },
  async create(opts) {
    const { CreateOSSandboxProvider } = await import("./createos-sandbox.js");
    return new CreateOSSandboxProvider({
      apiKey: opts.createosApiKey!,
      baseUrl: opts.createosBaseUrl,
      shape: opts.createosShape,
      rootfs: opts.createosRootfs,
      unreferencedMachines: opts.unreferencedMachines,
    });
  },
};
