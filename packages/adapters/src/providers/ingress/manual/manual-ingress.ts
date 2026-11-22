import type { IngressProvider, IngressStatus } from "@rakazo/adapter-kit";

/** The operator runs the tunnel or port forward; this only knows the address they gave it. */
export class ManualIngressProvider implements IngressProvider {
  constructor(readonly publicOrigin: string) {}

  describe() {
    return { id: "manual", label: "Your own tunnel" };
  }

  async publish(): Promise<void> {}

  async unpublish(): Promise<void> {}

  async status(): Promise<IngressStatus> {
    return { published: true };
  }
}
