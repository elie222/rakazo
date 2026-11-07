import type { MessagingInboundMessage } from "@rakazo/adapter-kit";
import type * as Adapters from "@rakazo/adapters";
import { SpaceDeletionInProgressError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type * as Inbound from "./messaging-inbound.js";
import type { MessagingInboundDeps } from "./messaging-inbound.js";
import type { TeamChatBridge } from "./team-chat-bridge.js";
import { createTeamChatInboundHandler } from "./team-chat-inbound.js";

vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  toTeamChatInbound: () => ({ kind: "mention", eventId: "100.1" }),
}));
vi.mock("./messaging-inbound.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Inbound>()),
  teamChatSenderCanWakeMessageRoutines: async () => true,
  wakeMessageRoutines: async () => {
    throw new SpaceDeletionInProgressError();
  },
}));

describe("TeamChat routine routing", () => {
  it("accepts and drops a message routine delivery to a Space being deleted", async () => {
    const bridge = {
      providerId: "slack",
      receive: vi.fn(async () => ({ deferred: true, externalMessageId: "external-1" })),
      startDeferredReservationHeartbeat: vi.fn(async () => ({
        lost: new Promise<never>(() => {}),
        stop: vi.fn(),
      })),
      markRoutineWakeInFlight: vi.fn(),
      clearRoutineWakeInFlight: vi.fn(),
      resolveDeferredMessage: vi.fn(async () => true),
      reconcileOnce: vi.fn(async () => undefined),
    };
    const handle = createTeamChatInboundHandler({} as MessagingInboundDeps, vi.fn());

    await expect(
      handle(bridge as unknown as TeamChatBridge, {} as MessagingInboundMessage),
    ).resolves.toBeUndefined();

    // The transcript was saved on receive; nothing falls back to the TeamChat agent.
    expect(bridge.receive).toHaveBeenCalledOnce();
    expect(bridge.resolveDeferredMessage).toHaveBeenCalledOnce();
    expect(bridge.resolveDeferredMessage).not.toHaveBeenCalledWith(
      "external-1",
      "agent",
      expect.anything(),
    );
    expect(bridge.reconcileOnce).not.toHaveBeenCalled();
  });
});
