import type { VoiceProvider } from "@rakazo/adapter-kit";
import type { VoiceCatalogEntry } from "@rakazo/contracts";

export interface VoiceProviderOptions {
  /** The caller's decision that this connection may reach a private address. */
  allowPrivateEndpoint?: boolean;
}

/** One voice provider: everything the factory, the catalog Settings reads, and tests read about it. */
export interface VoiceProviderDefinition {
  /** What Settings shows and what the connection form needs; the id is the registry key. */
  catalog: Omit<VoiceCatalogEntry, "id">;
  /** Whether this server can run it at all; without it the id is unknown here. */
  available?(): boolean;
  /** Whether Settings offers it, beyond being available. */
  listed?(options: VoiceProviderOptions): boolean;
  create(options: VoiceProviderOptions): VoiceProvider;
}
