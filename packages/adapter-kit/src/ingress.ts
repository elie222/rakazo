/** What an ingress provider can say about itself without a call. */
export type IngressDescriptor = {
  id: string;
  label: string;
  /** False when the operator runs the tunnel, so only they can stop it. */
  canUnpublish: boolean;
};

export type IngressStatus = { published: true } | { published: false; reason: string };

/**
 * Makes the deployment's inbound listener (webhooks and other deliveries only) reachable from the
 * internet at one public origin, so the app itself can stay on a private network.
 */
export interface IngressProvider {
  describe(): IngressDescriptor;
  /** The public origin outside services post to, such as `https://hooks.example.com`. */
  readonly publicOrigin: string;
  /** Forwards `publicOrigin` to `upstream`, the inbound listener's own address. Safe to repeat. */
  publish(upstream: string, signal: AbortSignal): Promise<void>;
  /** Stops forwarding. Safe to repeat. */
  unpublish(signal: AbortSignal): Promise<void>;
  /** Whether the provider reports `publicOrigin` as published, and why not when it is not. */
  status(signal: AbortSignal): Promise<IngressStatus>;
}
