import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computers/computer-provider-descriptor.js";
import { optional } from "../../../computers/computer-provider-descriptor.js";

export const dockerComputer: ComputerProviderDefinition = {
  capabilities: {
    terminal: true,
    inPlaceUpdate: true,
    nativeShell: false,
    runsOnUserMachine: false,
    screen: DEFAULT_COMPUTER_SCREEN,
    serverHomeMount: "always",
    serverOwnsStoredTeamHome: false,
    storedHomeIsBackup: true,
  },
  // Production without a supervisor token cannot run Docker computers; boot as none instead of exiting.
  unavailable: (source) =>
    source.NODE_ENV === "production" && !optional(source.SANDBOX_SUPERVISOR_TOKEN),
  async create(opts) {
    const { DockerSandboxProvider } = await import("./docker-sandbox.js");
    return new DockerSandboxProvider(
      opts.supervisorUrl ?? "http://127.0.0.1:7091",
      opts.supervisorToken,
    );
  },
};
