import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computers/computer-provider-descriptor.js";
import { positiveInteger } from "../../../computers/computer-provider-descriptor.js";

export const exeComputer: ComputerProviderDefinition = {
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
    exeKey: { name: "EXE_SANDBOX_KEY", required: true },
    exeTag: { name: "EXE_SANDBOX_TAG" },
    exeComputerImage: { name: "EXE_SANDBOX_COMPUTER_IMAGE" },
    exeCpus: positiveInteger("EXE_SANDBOX_CPUS"),
    exeMemory: { name: "EXE_SANDBOX_MEMORY" },
  },
  async create(opts) {
    const [{ ExeSandboxProvider }, { ExeSdkClient }] = await Promise.all([
      import("./exe-sandbox.js"),
      import("./exe-client.js"),
    ]);
    return new ExeSandboxProvider(
      {
        tag: opts.exeTag,
        computerImage: opts.exeComputerImage,
        cpus: opts.exeCpus,
        memory: opts.exeMemory,
        unreferencedMachines: opts.unreferencedMachines,
      },
      await ExeSdkClient.create(opts.exeKey!),
    );
  },
};
