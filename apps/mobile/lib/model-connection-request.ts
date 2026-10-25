import type { ModelBackupChoice } from "@rakazo/contracts";
import type { Href } from "expo-router";

export type ModelConnectionRequest = {
  provider: string;
  /** Prefills an OpenAI-compatible endpoint, such as the Ollama Cloud preset. */
  baseUrl?: string;
  /** Only the main model's empty first slot takes the new connection's model on connect. */
  makeDefault: boolean;
  /** Set when connecting fills a model slot; managing a connection leaves it unset. */
  /** May return the screen to continue in, such as the slot's picker for this provider. */
  onConnected?: (choice: ModelBackupChoice) => Promise<Href | undefined>;
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
