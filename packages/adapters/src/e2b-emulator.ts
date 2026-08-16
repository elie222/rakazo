import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { FakeSandboxProvider } from "./fake-sandbox.js";

/** Managed-provider protocol emulator backed by deterministic local state. */
export class ManagedSandboxEmulator extends FakeSandboxProvider {
  constructor(
    private readonly emulator: {
      id: string;
      kind: ComputerRef["kind"];
    } = { id: "e2b-emulator", kind: "e2b" },
  ) {
    super();
  }

  override describe() {
    return {
      ...super.describe(),
      id: this.emulator.id,
    };
  }

  override async provision(
    request: { botId: string; homePath: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const ref = await super.provision(request, context);
    return { ...ref, kind: this.emulator.kind };
  }
}
