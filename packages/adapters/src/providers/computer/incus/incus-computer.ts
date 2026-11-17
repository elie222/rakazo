import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computers/computer-provider-descriptor.js";
import { pem } from "../../../computers/computer-provider-descriptor.js";

export const incusComputer: ComputerProviderDefinition = {
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
    incusUrl: { name: "INCUS_SANDBOX_URL", required: true },
    incusClientCert: { name: "INCUS_SANDBOX_CLIENT_CERT", read: pem, required: true },
    incusClientKey: { name: "INCUS_SANDBOX_CLIENT_KEY", read: pem, required: true },
    incusServerCert: { name: "INCUS_SANDBOX_SERVER_CERT", read: pem },
    incusProject: { name: "INCUS_SANDBOX_PROJECT" },
    incusComputerImage: { name: "INCUS_SANDBOX_COMPUTER_IMAGE" },
    incusCpuLimit: { name: "INCUS_SANDBOX_CPU_LIMIT" },
    incusMemoryLimit: { name: "INCUS_SANDBOX_MEMORY_LIMIT" },
    incusProcessLimit: { name: "INCUS_SANDBOX_PROCESS_LIMIT" },
  },
  async create(opts) {
    const { IncusSandboxProvider } = await import("./incus-sandbox.js");
    return new IncusSandboxProvider({
      url: opts.incusUrl!,
      clientCert: opts.incusClientCert!,
      clientKey: opts.incusClientKey!,
      serverCert: opts.incusServerCert,
      project: opts.incusProject,
      computerImage: opts.incusComputerImage,
      cpuLimit: opts.incusCpuLimit,
      memoryLimit: opts.incusMemoryLimit,
      processLimit: opts.incusProcessLimit,
      unreferencedMachines: opts.unreferencedMachines,
    });
  },
};
