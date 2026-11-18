import type { AdapterContext, MessagingInboundMessage } from "@rakazo/adapter-kit";
import type { ReceivedFile, SaveReceivedFileResult } from "@rakazo/adapters";
import { savedFileLine, userTimeZone } from "@rakazo/adapters";
import { deadlineSignal, withAbort } from "@rakazo/core";
import type { PrismaClient, ProvisionedMessagingIdentity } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { RECEIVED_FILE_SAVE_TIMEOUT_MS } from "./limits.js";
import type { SenderQueue } from "./sender-queue.js";

/** Copies a received file into the bot's computer. */
export type SaveReceivedFile = (
  file: ReceivedFile & { timeZone: string },
  context: AdapterContext,
) => Promise<SaveReceivedFileResult>;

/**
 * Copies one received file into the bot's computer and returns the line that says where, or
 * nothing when it was not copied. A copy that fails or takes too long never holds up the message.
 * A save that ends after its deadline can still leave its copy, which the bot is not told about;
 * the folder's lease and a write that never replaces a file keep it from taking another's name,
 * and the cleanup removes it like any other copy.
 */
export async function saveReceivedCopy(
  deps: { prisma: PrismaClient; saveReceivedFile: SaveReceivedFile },
  ids: Pick<ProvisionedMessagingIdentity, "botId" | "userId" | "spaceId">,
  event: Pick<MessagingInboundMessage, "provider" | "handle" | "from">,
  file: { name: string; mimeType: string },
  bytes: Uint8Array,
  { saves, receivedAt }: { saves: SenderQueue; receivedAt: number },
): Promise<string | undefined> {
  const save = deps.saveReceivedFile;
  const signal = deadlineSignal(RECEIVED_FILE_SAVE_TIMEOUT_MS);
  const copy = async () => {
    // Named in the account's own time zone, or UTC when it has none, as the bot's clock is.
    const [bot, timeZone] = await Promise.all([
      deps.prisma.bot.findUnique({ where: { id: ids.botId }, select: { computerId: true } }),
      userTimeZone(deps.prisma, ids.userId),
    ]);
    const computerId = bot?.computerId ?? null;
    const operationId = `messaging-received-file:${event.provider}:${event.handle}`;
    const received = {
      bot: { id: ids.botId, computerId },
      sender: event.from,
      name: file.name,
      mimeType: file.mimeType,
      bytes,
      at: new Date(receivedAt),
      timeZone,
    };
    const context: AdapterContext = {
      operationId,
      traceId: operationId,
      spaceId: ids.spaceId,
      userId: ids.userId,
      botId: ids.botId,
      signal,
    };
    // Bots on one team computer share its received folder. The save also holds the folder
    // against other processes; this only keeps this process's saves from waiting on that. The
    // queue stops waiting on a save at its deadline, so one that hangs never holds up the next.
    return saves.run(computerId ?? `bot:${ids.botId}`, async () => {
      signal.throwIfAborted();
      return withAbort(save(received, context), signal);
    });
  };
  const result = await bestEffort(
    "copy a received file into the bot's computer",
    withAbort(copy(), signal),
  );
  return result && "saved" in result ? savedFileLine(result.saved) : undefined;
}
