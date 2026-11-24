import type { AdapterContext, MemorySnapshot, MemoryStore } from "@rakazo/adapter-kit";
import { MEMORY_ARCHIVE_PATH } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging";
import type { MemoryPromptDocument } from "./memory-context.prompt.js";
import { AGENT_MEMORY_MAX_BYTES, buildAgentMemoryPrompt } from "./memory-context.prompt.js";
import { splitEndedEntries } from "./memory-expiry.js";
import { appendMemoryFact } from "./memory-tools.js";

/** Renders the bot's memory for a run, first moving entries whose end date has passed to the archive. */
export async function loadAgentMemoryContext(
  memory: MemoryStore,
  botId: string,
  context: AdapterContext,
  options: { today?: string; maxBytes?: number } = {},
): Promise<string | undefined> {
  const stored = await readStoredMemory(memory, botId, context);
  if (options.today) {
    await bestEffort(
      "archive ended memory entries",
      archiveEndedEntries(memory, botId, stored.bot, options.today, context),
    );
  }
  return buildAgentMemoryPrompt(
    promptDocuments(stored, options.today),
    options.maxBytes ?? AGENT_MEMORY_MAX_BYTES,
  ).text;
}

/**
 * The bot's own memory plus the user's, in the shape the prompt builder reads. The archive is
 * never shown, and with `today` neither are entries that ended before it.
 */
export async function readAgentMemory(
  memory: MemoryStore,
  botId: string,
  context: AdapterContext,
  today?: string,
): Promise<MemoryPromptDocument[]> {
  return promptDocuments(await readStoredMemory(memory, botId, context), today);
}

type StoredDocument = MemorySnapshot["documents"][number];
type StoredMemory = { bot: StoredDocument[]; user: StoredDocument[] };

async function readStoredMemory(
  memory: MemoryStore,
  botId: string,
  context: AdapterContext,
): Promise<StoredMemory> {
  const [bot, user] = await Promise.all([
    memory.read({ scope: "bot", botId }, context),
    memory.read({ scope: "user" }, context),
  ]);
  return { bot: bot.documents, user: user.documents };
}

function promptDocuments(stored: StoredMemory, today?: string): MemoryPromptDocument[] {
  return [
    ...stored.bot
      .filter((document) => document.path !== MEMORY_ARCHIVE_PATH)
      .map((document) => ({
        ...document,
        scope: "bot" as const,
        content: today ? splitEndedEntries(document.content, today).current : document.content,
      })),
    ...stored.user.map((document) => ({ ...document, scope: "user" as const })),
  ];
}

/**
 * Appends ended entries to the archive before taking them out of their documents, so a failure
 * between the saves repeats the move next run instead of losing them; the archive keeps one copy.
 */
async function archiveEndedEntries(
  memory: MemoryStore,
  botId: string,
  documents: StoredDocument[],
  today: string,
  context: AdapterContext,
): Promise<void> {
  const moves = documents
    .filter((document) => document.path !== MEMORY_ARCHIVE_PATH)
    .map((document) => ({ document, ...splitEndedEntries(document.content, today) }))
    .filter((move) => move.ended.length);
  if (!moves.length) return;
  const archive = documents.find((document) => document.path === MEMORY_ARCHIVE_PATH);
  await memory.commit(
    {
      scope: "bot",
      botId,
      path: MEMORY_ARCHIVE_PATH,
      content: moves.flatMap((move) => move.ended).reduce(appendMemoryFact, archive?.content ?? ""),
      expectedRevision: archive?.revision ?? 0,
    },
    context,
  );
  for (const { document, current } of moves) {
    await memory.commit(
      {
        scope: "bot",
        botId,
        path: document.path,
        content: current,
        expectedRevision: document.revision,
      },
      context,
    );
  }
}
