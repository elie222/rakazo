import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import { ManagedSandboxEmulator } from "./e2b-emulator.js";

/** Managed-provider emulator configured with Boat identity. */
export class BoatSandboxEmulator extends ManagedSandboxEmulator {
  private starts = 0;

  /** `startLimit` mirrors Boat's account start quota: provisions beyond it are rate limited. */
  constructor(private readonly options: { startLimit?: number } = {}) {
    super({ id: "boat-emulator", kind: "boat" });
  }

  override async provision(
    request: { botId: string; homePath: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    // Like Boat, only a create or a resume counts; reconnecting to a running computer is free.
    if (!this.boxes.get(`fake-${request.botId}`)?.running) {
      if (this.options.startLimit !== undefined && this.starts >= this.options.startLimit) {
        throw new SandboxRateLimitError();
      }
      this.starts += 1;
    }
    return super.provision(request, context);
  }
}
