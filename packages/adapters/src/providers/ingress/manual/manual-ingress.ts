import type { IngressProvider, IngressStatus } from "@rakazo/adapter-kit";

/** The operator runs the tunnel or port forward; this only knows the address they gave it. */
export class ManualIngressProvider implements IngressProvider {
  constructor(readonly publicOrigin: string) {}

  describe() {
    return { id: "manual", label: "Your own tunnel", canUnpublish: false };
  }

  async publish(): Promise<void> {}

  async unpublish(): Promise<void> {
    throw new Error("Rakazo does not run this tunnel: stop it or its port forward yourself");
  }

  async status(): Promise<IngressStatus> {
    return { published: true };
  }
}
