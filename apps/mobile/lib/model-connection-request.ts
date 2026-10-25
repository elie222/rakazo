import type { ModelRoleChoice } from "@rakazo/contracts";
import type { Href } from "expo-router";
import type { SettingsTarget } from "./settings-target";

export type ModelConnectionRequest = {
  provider: string;
  /** The connection to manage, or null to add another one for the provider. */
  credentialId: string | null;
  /** Prefills an OpenAI-compatible endpoint, such as the Ollama Cloud preset. */
  baseUrl?: string;
  /** Only the main model's empty first slot takes the new connection's model on connect. */
  makeDefault: boolean;
  /** Whose main model makeDefault sets: the account's, or a Space's override. */
  target: SettingsTarget;
  /**
   * Set when connecting fills a model slot; managing a connection leaves it unset.
   * May return the screen to continue in, such as the slot's picker for this connection.
   */
  onConnected?: (choice: ModelRoleChoice) => Promise<Href | undefined>;
};

let nextId = 0;
const requests = new Map<string, ModelConnectionRequest>();

/** Ephemeral, owner-scoped connect requests; never serialized into links or storage. */
export function openModelConnection(request: ModelConnectionRequest): string {
  const id = String(++nextId);
  requests.set(id, request);
  return id;
}

export function modelConnectionRequest(id: string): ModelConnectionRequest | undefined {
  return requests.get(id);
}

export function closeModelConnection(id: string): void {
  requests.delete(id);
}
