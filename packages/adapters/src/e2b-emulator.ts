import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { FakeSandboxProvider } from "./fake-sandbox.js";

/** Managed-provider protocol emulator backed by deterministic local state. */
export class ManagedSandboxEmulator extends FakeSandboxProvider {
  readonly dest = this.boxes;

  override describe() {
    return {
      ...super.describe(),
      id: "e2b-emulator",
    };
  }

  override async provision(
    request: { botId: string; homePath: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const ref = await super.provision(request, context);
    return { ...ref, kind: "e2b" };
  }
}
