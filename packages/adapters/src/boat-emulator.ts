import { ManagedSandboxEmulator } from "./e2b-emulator.js";

/** Managed-provider emulator configured with Boat identity. */
export class BoatSandboxEmulator extends ManagedSandboxEmulator {
  constructor() {
    super({ id: "boat-emulator", kind: "boat" });
  }
}
