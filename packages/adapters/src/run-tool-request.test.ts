import { describe, expect, it, vi } from "vitest";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareToolRequest } from "./run-tool-request.js";

function ownBotUpdateCall() {
  const ctx = {
    deps: {
      prisma: {
        bot: {
          findUnique: async () => ({ fleetManagement: true }),
          findUniqueOrThrow: async () => ({ instructions: "" }),
        },
      },
    },
    run: { trigger: "user", threadId: "thread-1" },
    bot: { id: "bot-1" },
    source: { ownerStartedRun: true },
    state: { tainted: true, earlierAttempt: Promise.resolve(false) },
    trust: {
      loadAutoReviewPreference: async () => ({ enabled: true, skipApprovals: false }),
      receivedOutsideMessage: async () => false,
    },
    secrets: [],
  };
  const request: ToolRequest = {
    name: "update_bot",
    args: { model: "test-model" },
    executionId: JSON.stringify(["pi-tool", "main", "call-1"]),
    connectorCall: {
      tool: "update_bot",
      args: { model: "test-model" },
      executionId: JSON.stringify(["pi-tool", "main", "call-1"]),
      route: undefined,
    },
    effectRequest: { model: "test-model" },
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool: undefined,
    approvedEffectKey: undefined,
    replayEffectToolName: "update_bot",
    fleetSummary: undefined,
    heldForApproval: false,
    purchase: undefined,
  };
  return { ctx, request: () => structuredClone(request) };
}

describe("prepareToolRequest: update_bot owner settings after outside content", () => {
  it("refuses once, then ends the turn instead of repeating the refusal", async () => {
    const { ctx, request } = ownBotUpdateCall();
    await expect(prepareToolRequest(ctx as never, request())).resolves.toEqual({
      error: expect.stringContaining("outside content"),
    });
    const repeat = await prepareToolRequest(ctx as never, request());
    expect(repeat).toMatchObject({
      kind: "agent_tool_result",
      terminate: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining("Settings"),
        },
      ],
    });
    expect(JSON.stringify(repeat)).not.toContain("outside content");
  });

  it("keeps preparing the change while the run is untainted", async () => {
    const { ctx, request } = ownBotUpdateCall();
    ctx.state.tainted = false;
    for (let index = 0; index < 3; index += 1) {
      await expect(prepareToolRequest(ctx as never, request())).resolves.toBeUndefined();
    }
  });
});

describe("private task tools after shared-channel messages", () => {
  it.each([
    "schedule_create",
    "schedule_list",
    "schedule_update",
    "schedule_cancel",
    "skill_read",
    "skill_create",
    "skill_update",
    "skill_delete",
  ])("refuses %s for original and claimed shared-channel messages", async (name) => {
    for (const originalChannel of [true, false]) {
      const ctx = {
        deps: {
          prisma: { steeringMessage: { findFirst: vi.fn(async () => ({ id: "claimed" })) } },
        },
        run: {},
        bot: {},
        runId: "run-1",
        source: { messagingChannelRun: originalChannel },
      };
      const request = { name, args: {}, executionId: "call-1" } as ToolRequest;
      await expect(prepareToolRequest(ctx as never, request)).resolves.toEqual({
        error: "This tool is unavailable after a shared-channel message.",
      });
    }
  });

  it.each(["user", "bot_message", "webhook"])(
    "keeps %s task tools available without a channel message",
    async (trigger) => {
      const ctx = {
        deps: { prisma: { steeringMessage: { findFirst: async () => null } } },
        run: { trigger },
        bot: {},
        runId: "run-1",
        source: { messagingChannelRun: false },
      };
      for (const name of ["schedule_update", "skill_read"]) {
        await expect(
          prepareToolRequest(
            ctx as never,
            { name, args: {}, executionId: "call-1" } as ToolRequest,
          ),
        ).resolves.toBeUndefined();
      }
    },
  );
});
