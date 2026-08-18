import { ManagedSandboxEmulator } from "./e2b-emulator.js";

/** Box protocol emulator with the provider's single-desktop constraint. */
export class BoxSandboxEmulator extends ManagedSandboxEmulator {
  constructor() {
    super({ id: "box-emulator", kind: "box" });
  }
}
