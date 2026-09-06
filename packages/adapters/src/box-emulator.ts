import { ManagedSandboxEmulator } from "./e2b-emulator.js";

/** Managed-provider emulator configured with Box identity. */
export class BoxSandboxEmulator extends ManagedSandboxEmulator {
  constructor() {
    super({ id: "box-emulator", kind: "box" });
  }
}
