import { ManagedSandboxEmulator } from "./e2b-emulator.js";

/** Managed-provider emulator configured with Daytona identity. */
export class DaytonaSandboxEmulator extends ManagedSandboxEmulator {
  constructor() {
    super({ id: "daytona-emulator", kind: "daytona" });
  }
}
