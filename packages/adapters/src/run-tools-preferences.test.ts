import { describe, expect, it } from "vitest";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";
import { preferenceTools } from "./run-tools-preferences.js";

function fakeAccount(ownerStartedRun = true, tainted = false, nextApprovedTool?: string) {
  const users = {
    starter: { timezone: "UTC" as string | null, marketingEmailOptOutAt: null as Date | null },
    other: { timezone: "UTC" as string | null, marketingEmailOptOutAt: null as Date | null },
  };
  type Id = keyof typeof users;
  const ctx = {
    deps: {
      prisma: {
        user: {
          findUniqueOrThrow: async ({ where }: { where: { id: Id } }) => ({ ...users[where.id] }),
          update: async ({ where, data }: { where: { id: Id }; data: object }) => {
            const defined = Object.entries(data).filter(([, value]) => value !== undefined);
            Object.assign(users[where.id], Object.fromEntries(defined));
            return { ...users[where.id] };
          },
        },
      },
    },
    run: { userId: "starter" },
    source: { ownerStartedRun },
    runId: "run-1",
    state: { tainted, earlierAttempt: Promise.resolve(false) },
    trust: { receivedOutsideMessage: async () => false },
  };
  const call = (args: Record<string, unknown>) =>
    preferenceTools.update_preferences!(
      ctx as never,
      {
        name: "update_preferences",
        args,
        executionId: "call-1",
        nextApprovedTool,
        finish: async (result: unknown) => result,
      } as never,
    );
  return { users, call };
}

describe("update_preferences", () => {
  it("reads the current values when called with no fields", async () => {
    const { call } = fakeAccount();
    await expect(call({})).resolves.toEqual({ timezone: "UTC", marketingEmails: true });
  });

  it("patches only the starter's own timezone and marketing emails", async () => {
    const { users, call } = fakeAccount();
    await expect(call({ timezone: "Europe/Berlin", marketingEmails: false })).resolves.toEqual({
      timezone: "Europe/Berlin",
      marketingEmails: false,
    });
    expect(users.starter.marketingEmailOptOutAt).toBeInstanceOf(Date);
    expect(users.other).toEqual({ timezone: "UTC", marketingEmailOptOutAt: null });
    await expect(call({ marketingEmails: true })).resolves.toEqual({
      timezone: "Europe/Berlin",
      marketingEmails: true,
    });
  });

  it("rejects an unknown timezone and leaves the account as it was", async () => {
    const { users, call } = fakeAccount();
    await expect(call({ timezone: "Mars/Olympus" })).resolves.toEqual({
      error: "timezone: Unknown timezone",
    });
    await expect(call({ timezone: "+05:00" })).resolves.toHaveProperty("error");
    expect(users.starter.timezone).toBe("UTC");
  });

  it.each([
    { email: "new-address@example.test" },
    { password: "hunter2" },
    { deleteAccount: true },
    { autoReview: false },
  ])("refuses fields that stay in the app's settings: %o", async (args) => {
    const { users, call } = fakeAccount();
    const result = await call({ ...args, timezone: "Asia/Tokyo" });
    expect(result).toEqual({ error: expect.stringContaining(Object.keys(args)[0]!) });
    expect(users.starter.timezone).toBe("UTC");
  });

  it("refuses a run the user did not start", async () => {
    const { users, call } = fakeAccount(false);
    await expect(call({ timezone: "Asia/Tokyo" })).resolves.toHaveProperty("error");
    expect(users.starter.timezone).toBe("UTC");
  });

  it("reads but no longer writes once outside content entered the run", async () => {
    const { users, call } = fakeAccount(true, true);
    await expect(call({ marketingEmails: false })).resolves.toEqual({
      error: expect.stringContaining("outside content"),
    });
    expect(users.starter.marketingEmailOptOutAt).toBeNull();
    await expect(call({})).resolves.toEqual({ timezone: "UTC", marketingEmails: true });
  });

  it("applies a change the owner approved after outside content", async () => {
    const { users, call } = fakeAccount(true, true, "update_preferences");
    await expect(call({ timezone: "Asia/Tokyo" })).resolves.toMatchObject({
      timezone: "Asia/Tokyo",
    });
    expect(users.starter.timezone).toBe("Asia/Tokyo");
  });

  it("is offered only on runs the account owner started", () => {
    const offered = (trigger: string, followUpFromUser = false) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger,
        semanticMemoryEnabled: false,
        messagingChannelRun: trigger === "messaging",
        followUpFromUser,
      }).some((tool) => tool.name === "update_preferences");
    expect(offered("user")).toBe(true);
    expect(offered("call_end")).toBe(true);
    expect(offered("follow_up", true)).toBe(true);
    for (const trigger of [
      "follow_up",
      "routine",
      "bot_message",
      "messaging",
      "webhook",
      "spawn",
      "tickets",
      "created",
    ])
      expect(offered(trigger), trigger).toBe(false);
  });
});
