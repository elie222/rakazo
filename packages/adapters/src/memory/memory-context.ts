import type { AdapterContext, MemoryStore } from "@rakazo/adapter-kit";
import type { MemoryPromptDocument } from "./memory-context.prompt.js";
import { AGENT_MEMORY_MAX_BYTES, buildAgentMemoryPrompt } from "./memory-context.prompt.js";

export async function loadAgentMemoryContext(
  memory: MemoryStore,
  botId: string,
  context: AdapterContext,
  maxBytes = AGENT_MEMORY_MAX_BYTES,
  inclusion: MemoryInclusion = {},
): Promise<string | undefined> {
  const documents = await readAgentMemory(memory, botId, context, inclusion);
  return buildAgentMemoryPrompt(documents, maxBytes).text;
}

/** Which memory banks this bot's settings put in its prompt. */
export interface MemoryInclusion {
  /** The bot's own notes; absent means included. */
  includeBot?: boolean;
  /** The Space's shared notes; absent means included. */
  includeUser?: boolean;
}

/** The bot's own memory plus the user's, in the shape the prompt builder reads. */
export async function readAgentMemory(
  memory: MemoryStore,
  botId: string,
  context: AdapterContext,
  inclusion: MemoryInclusion = {},
): Promise<MemoryPromptDocument[]> {
  const includeBot = inclusion.includeBot ?? true;
  const includeUser = inclusion.includeUser ?? true;
  const [botMemory, userMemory] = await Promise.all([
    includeBot ? memory.read({ scope: "bot", botId }, context) : { documents: [] },
    includeUser ? memory.read({ scope: "user" }, context) : { documents: [] },
  ]);
  return [
    ...botMemory.documents.map((document) => ({ ...document, scope: "bot" as const })),
    ...userMemory.documents.map((document) => ({ ...document, scope: "user" as const })),
  ];
}
