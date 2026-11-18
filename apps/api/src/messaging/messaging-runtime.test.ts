import { deferred } from "@rakazo/core/test-async";
import { describe, expect, it, vi } from "vitest";
import type { InboundAttachmentStore } from "./inbound-attachments.js";
import { DOWNLOAD_BUDGET_FILES } from "./intake/limits.js";
import { createInboundAttachmentStores } from "./messaging-runtime.js";

describe("createInboundAttachmentStores", () => {
  it("keeps team-chat files out of the direct-message download budget", async () => {
    const stores = createInboundAttachmentStores({
      prisma: { artifact: { findFirst: vi.fn(async () => null) } } as never,
      // Nothing is kept: the test only watches which downloads start.
      artifacts: {
        put: vi.fn(async () => {
          throw new Error("not kept in this test");
        }),
      } as never,
      maxUploadSizeBytes: 10,
    });
    const store = (to: InboundAttachmentStore, name: string, fetch: () => Promise<Uint8Array>) =>
      to({
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        attachment: { name, mimeType: "image/jpeg", fetch },
        clientNonce: name,
        downloadTimeoutMs: 60_000,
      });
    // Direct-message files of unreported size fill the budget.
    const held = deferred<Uint8Array>();
    const direct = Array.from({ length: DOWNLOAD_BUDGET_FILES }, (_, index) =>
      store(stores.direct, `photo-${index}.jpg`, () => held.promise),
    );
    const nextDirect = vi.fn(async () => new Uint8Array([1]));
    const teamChat = vi.fn(async () => new Uint8Array([1]));
    const waiting = [
      store(stores.direct, "photo-next.jpg", nextDirect),
      store(stores.teamChat, "channel.jpg", teamChat),
    ];
    // Each ends in the artifact store this test leaves out.
    const ended = Promise.allSettled([...direct, ...waiting]);

    await vi.waitFor(() => expect(teamChat).toHaveBeenCalledOnce());
    expect(nextDirect).not.toHaveBeenCalled();
    held.resolve(new Uint8Array([1]));
    await ended;
    expect(nextDirect).toHaveBeenCalledOnce();
  });
});
