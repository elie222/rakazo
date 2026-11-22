import { deferred } from "@rakazo/core/test-async";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { InboundAttachmentStore } from "./inbound-attachments.js";
import { DOWNLOAD_BUDGET_FILES } from "./intake/limits.js";
import { createInboundAttachmentStores, startMessagingRuntime } from "./messaging-runtime.js";

const directMessages = vi.hoisted(() => ({
  prepareHandOff: vi.fn(async () => undefined),
  handOffPending: vi.fn(async () => undefined),
  inbound: vi.fn(async () => undefined),
}));

vi.mock("./messaging-inbound.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createMessagingInboundHandler: () => Object.assign(directMessages.inbound, directMessages),
}));

describe("startMessagingRuntime", () => {
  it("makes pending settle jobs due soon once receiving stops, before the rest of the stop", async () => {
    const messaging = {
      onInbound: vi.fn(),
      stopReceiving: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      platforms: () => [],
      acknowledge: vi.fn(),
      handleWebhook: vi.fn(),
    };
    const runtime = await startMessagingRuntime({
      app: new Hono(),
      prisma: {} as never,
      events: {} as never,
      jobs: {} as never,
      sandbox: {} as never,
      secrets: {} as never,
      artifacts: {} as never,
      env: { maxUploadSizeBytes: 10, messagingOpenSignup: false } as never,
      messaging: messaging as never,
      messagingInstallations: undefined,
      delivery: {} as never,
      teamChat: {} as never,
    });

    // The app stops receiving early in its shutdown, then drains connections and runs.
    await runtime.stopReceiving();
    expect(directMessages.prepareHandOff).toHaveBeenCalled();
    expect(directMessages.handOffPending).not.toHaveBeenCalled();

    await runtime.stop();
    expect(directMessages.handOffPending).toHaveBeenCalledOnce();
    expect(directMessages.prepareHandOff.mock.invocationCallOrder[0]).toBeLessThan(
      directMessages.handOffPending.mock.invocationCallOrder[0]!,
    );
  });
});

describe("inbound routing", () => {
  /** Starts the runtime far enough to capture the handler the messaging surface calls. */
  async function inboundHandler(
    env: Record<string, unknown>,
    platform: { provider: string; teamRooms: Record<string, unknown> } = {
      provider: "discord",
      teamRooms: { requiresWorkspace: true },
    },
  ) {
    const handlers: ((event: unknown) => Promise<void>)[] = [];
    const messaging = {
      onInbound: (handler: (event: unknown) => Promise<void>) => handlers.push(handler),
      stopReceiving: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      // What a mounted room-style platform declares about its rooms.
      platforms: () => [
        {
          ...platform,
          capabilities: { direct: true, groups: true, receipt: "reaction" },
        },
      ],
      acknowledge: vi.fn(),
      handleWebhook: vi.fn(),
      startReceiving: vi.fn(async () => undefined),
    };
    await startMessagingRuntime({
      app: new Hono(),
      prisma: {} as never,
      events: {} as never,
      jobs: {} as never,
      sandbox: {} as never,
      secrets: {} as never,
      artifacts: {} as never,
      env: {
        maxUploadSizeBytes: 10,
        messagingOpenSignup: false,
        teamChatBotIds: {},
        ...env,
      } as never,
      messaging: messaging as never,
      messagingInstallations: undefined,
      delivery: {} as never,
      teamChat: {} as never,
    });
    return handlers[0]!;
  }

  const guildMessage = {
    type: "message",
    provider: "discord",
    handle: "m-1",
    threadId: "discord:G1:C1",
    isDirect: false,
    workspaceId: "G1",
    conversationKey: "discord:G1:C1",
    content: "@agent hello",
    mentionsBot: true,
  };

  it("drops a Discord guild message when no bot owns guild channels", async () => {
    const handle = await inboundHandler({});
    await handle(guildMessage);

    // Nothing answers, and nothing posts the personal-linking intro into the channel.
    expect(directMessages.inbound).not.toHaveBeenCalled();
  });

  it("keeps routing a Slack channel to personal linking with no team-chat bot", async () => {
    // A Slack channel could be linked as a personal group before team chat existed,
    // and a deployment with no team-chat bot must not lose that.
    const handle = await inboundHandler(
      {},
      { provider: "slack", teamRooms: { requiresWorkspace: true, personalLinking: true } },
    );
    await handle({
      ...guildMessage,
      provider: "slack",
      threadId: "slack:C1",
      workspaceId: "T1",
      conversationKey: "slack:C1",
    });

    expect(directMessages.inbound).toHaveBeenCalledOnce();
  });

  it("keeps group linking on a platform that has no team rooms", async () => {
    // Only a declared team room can be closed to linking; a group chat elsewhere is
    // still a personal group to link.
    const handle = await inboundHandler(
      {},
      { provider: "sendblue", teamRooms: undefined as never },
    );
    await handle({
      ...guildMessage,
      provider: "sendblue",
      threadId: "sendblue:group-1",
      workspaceId: undefined,
      conversationKey: "sendblue:group-1",
    });

    expect(directMessages.inbound).toHaveBeenCalledOnce();
  });

  it("still routes a Discord direct message to personal linking", async () => {
    const handle = await inboundHandler({});
    await handle({ ...guildMessage, threadId: "discord:@me:D1", isDirect: true });

    expect(directMessages.inbound).toHaveBeenCalledOnce();
  });
});

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
