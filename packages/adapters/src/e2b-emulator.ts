import type {
  AdapterContext,
  ComputerActionRequest,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
} from "@rakazo/adapter-kit";
import { SingleScreenClaimTracker } from "./computer-screens.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";

/** Managed-provider protocol emulator backed by deterministic local state. */
export class ManagedSandboxEmulator extends FakeSandboxProvider {
  private readonly screenClaims = new SingleScreenClaimTracker();

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
      capabilities: {
        ...super.describe().capabilities,
        multiScreen: false,
      },
    };
  }

  override async provision(
    request: { botId: string; homePath: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const ref = await super.provision(request, context);
    return { ...ref, kind: this.emulator.kind };
  }

  override async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    this.claim(computer, context);
    return super.sendInput(computer, input, lease, context);
  }

  override async observe(computer: ComputerRef, context: AdapterContext) {
    this.claim(computer, context);
    return super.observe(computer, context);
  }

  override async act(
    computer: ComputerRef,
    request: ComputerActionRequest,
    context: AdapterContext,
  ) {
    this.claim(computer, context);
    return super.act(computer, request, context);
  }

  override async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    this.screenClaims.release(computer.providerRef || computer.id, context);
    await super.releaseScreen(computer, context);
  }

  override async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    this.screenClaims.release(computer.providerRef || computer.id);
    return super.stop(computer, context);
  }

  override async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    this.screenClaims.release(computer.providerRef || computer.id);
    return super.destroy(computer, context);
  }

  private claim(computer: ComputerRef, context: AdapterContext) {
    this.screenClaims.claim(computer.providerRef || computer.id, context);
  }
}
