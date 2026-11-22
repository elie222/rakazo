import { hindsightMemory } from "../providers/memory/hindsight/hindsight-memory.js";
import { honchoMemory } from "../providers/memory/honcho/honcho-memory.js";
import { mnemoverseMemory } from "../providers/memory/mnemoverse/mnemoverse-memory.js";
import { serenityMemory } from "../providers/memory/serenity/serenity-memory.js";
import { supermemoryMemory } from "../providers/memory/supermemory/supermemory-memory.js";
import type { MemoryProviderDefinition } from "./memory-provider-descriptor.js";

/**
 * Every memory provider this build has, by id. The factory, Settings and the conformance
 * fixtures all read from here. A Space picks from them in this order; the first is offered first.
 */
export const memoryProviders = {
  supermemory: supermemoryMemory,
  serenity: serenityMemory,
  honcho: honchoMemory,
  hindsight: hindsightMemory,
  mnemoverse: mnemoverseMemory,
} satisfies Record<string, MemoryProviderDefinition>;

/** An id this build has a memory provider for. Outside adapters a provider id is an opaque string. */
export type MemoryProviderId = keyof typeof memoryProviders;

export function knownMemoryProvider(id: string): MemoryProviderDefinition | undefined {
  return Object.hasOwn(memoryProviders, id) ? memoryProviders[id as MemoryProviderId] : undefined;
}
