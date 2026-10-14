import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

describe("call route gates", () => {
  it.each([undefined, false])(
    "rejects all call RPCs when disabled (%s)",
    async (phoneCallsEnabled) => {
      const query = vi.fn(() => {
        throw new Error("Unexpected database access");
      });
      const client = createRouterClient(
        createRouter({
          prisma: new Proxy({}, { get: () => query }),
          env: { phoneCallsEnabled },
        } as unknown as RouterDeps),
        { context: { actor } },
      );
      const input = { botId: "bot-1", callId: "call-1" };
      for (const call of [
        () => client.threads.answerCall(input),
        () => client.threads.declineCall({ ...input, outcome: "declined" }),
        () => client.threads.endCall(input),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("requires authentication even when enabled", async () => {
    const client = createRouterClient(
      createRouter({ env: { phoneCallsEnabled: true } } as unknown as RouterDeps),
      { context: {} },
    );
    const input = { botId: "bot-1", callId: "call-1" };
    await expect(client.threads.answerCall(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      client.threads.declineCall({ ...input, outcome: "declined" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client.threads.endCall(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
