import { createHash } from "node:crypto";
import type { MessagingInboundMessage } from "@rakazo/adapter-kit";
import type { MessagingDelivery, OutboundLane } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";

/** What a sender this line does not know is told, at most once a day per address. */
export const MESSAGING_LINK_HINT =
  "Hi. To chat with your Rakazo bot here, open Rakazo, go to Settings → Messaging, choose Connect, and send the code it shows to this chat.";

/**
 * Tells a sender who is not linked how to link, instead of leaving them in silence. The key is
 * per app, per address and per UTC day, so a repeat sender gets one hint a day. It holds a hash
 * of the address, not the address. Every unlinked sender gets the same words, whatever they
 * sent, so the reply says nothing about link codes, bots or accounts.
 */
export async function sendLinkHint(
  deps: { prisma: PrismaClient; delivery: Pick<MessagingDelivery, "recordIn" | "send"> },
  event: Pick<MessagingInboundMessage, "provider" | "from" | "threadId">,
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const address = createHash("sha256").update(event.from).digest("hex").slice(0, 32);
  const lane: OutboundLane = { identityId: null, threadId: event.threadId };
  const added = await deps.prisma.$transaction((tx) =>
    deps.delivery.recordIn(tx, lane, [
      {
        idempotencyKey: `link-hint:${event.provider}:${address}:${day}`,
        kind: "intro",
        threadId: event.threadId,
        body: MESSAGING_LINK_HINT,
      },
    ]),
  );
  if (added.length > 0) await deps.delivery.send([lane]);
}
