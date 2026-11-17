import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computer-provider-descriptor.js";

export const appleContainerComputer: ComputerProviderDefinition = {
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
    localVmCli: { name: "LOCAL_VM_CLI" },
    localVmComputerImage: { name: "LOCAL_VM_COMPUTER_IMAGE" },
    localVmCpus: { name: "LOCAL_VM_CPUS" },
    localVmMemory: { name: "LOCAL_VM_MEMORY" },
  },
  async create(opts) {
    const { AppleContainerSandboxProvider } = await import("./apple-container-sandbox.js");
    return new AppleContainerSandboxProvider({
      cli: opts.localVmCli,
      computerImage: opts.localVmComputerImage,
      cpus: opts.localVmCpus,
      memory: opts.localVmMemory,
    });
  },
};
