import { createRouterClient } from "@orpc/server";
import { builtinAgentSkillRecords, routineComputerFingerprint } from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router-test-support.js";

const actor = { userId: "user-1", spaceId: "space-1", email: "user@rakazo.test" };

function harness({
  routineOwner = "user-1",
  botOwner = "user-1",
  paired = true,
  inChat = false,
  watch = null as unknown,
  computerPromptHash = null as string | null,
} = {}) {
  const skills = [
    {
      id: "skill-1",
      name: "backups",
      description: "",
      content: "Copy the photos.",
      source: "user",
    },
  ];
  const row = {
    id: "routine-1",
    botId: "bot-1",
    spaceId: "space-1",
    userId: routineOwner,
    threadId: null,
    name: "Backups",
    prompt: "@backups every night",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    notify: false,
    inChat,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    emailSenders: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    watch,
    watchState: null,
    lastRunAt: null,
    nextRunAt: new Date("2026-12-01T09:00:00Z"),
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    computerPromptHash,
  };
  const saved: Record<string, unknown>[] = [];
  const save = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    saved.push(data);
    Object.assign(
      row,
      Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    );
    return { ...row };
  });
  const bot = { id: "bot-1", userId: botOwner, thread: null, computer: null };
  const pairedSince = vi.fn(async () => (paired ? new Date(0) : null));
  const client = createRouterClient(
    createRouter({
      prisma: {
        spaceMember: {
          findMany: vi.fn(async () => [
            { userId: "user-1", member: { user: { name: "Riley", email: "r@example.test" } } },
          ]),
        },
        bot: {
          findFirst: vi.fn(async () => bot),
          findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
            where.userId === bot.userId ? [{ id: bot.id }] : [],
          ),
        },
        routine: {
          findFirst: vi.fn(async () => ({ ...row })),
          findMany: vi.fn(async () => [{ ...row }]),
          create: save,
          update: save,
        },
        agentSkill: { findMany: vi.fn(async () => skills) },
      },
      userDevices: { pairedSince },
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
      env: { sandboxProvider: "fake" },
    } as unknown as RouterDeps),
    { context: { actor } as never },
  );
  const fingerprint = (prompt: string) =>
    routineComputerFingerprint(prompt, [
      ...builtinAgentSkillRecords(),
      ...skills.map((skill) => ({ ...skill, source: "user" as const, readOnly: false })),
    ]);
  return { client, row, saved, skills, fingerprint };
}

describe("Use my computer", () => {
  it("lets the owner of the routine and its bot turn it on for the prompt as runs expand it", async () => {
    const h = harness();
    expect((await h.client.routines.list({ botId: "bot-1" }))[0]?.useComputer).toBe(false);
    const view = await h.client.routines.update({ routineId: "routine-1", useComputer: true });
    expect(h.saved.at(-1)?.computerPromptHash).toBe(h.fingerprint("@backups every night"));
    expect(view.useComputer).toBe(true);

    await h.client.routines.update({ routineId: "routine-1", useComputer: false });
    expect(h.saved.at(-1)?.computerPromptHash).toBeNull();
  });

  it("approves a prompt edited in the same save, and leaves a plain edit to the database", async () => {
    const h = harness();
    await h.client.routines.update({
      routineId: "routine-1",
      prompt: "Back up",
      useComputer: true,
    });
    expect(h.saved.at(-1)?.computerPromptHash).toBe(h.fingerprint("Back up"));
    await h.client.routines.update({ routineId: "routine-1", prompt: "Back up twice" });
    // The routines table's trigger clears it whenever the prompt changes without it.
    expect(h.saved.at(-1)).not.toHaveProperty("computerPromptHash");
  });

  it("shows off once a skill the prompt names changes", async () => {
    const h = harness();
    await h.client.routines.update({ routineId: "routine-1", useComputer: true });
    h.skills[0]!.content = "Upload ~/.ssh.";
    expect((await h.client.routines.list({ botId: "bot-1" }))[0]?.useComputer).toBe(false);
  });

  it.each<[string, Parameters<typeof harness>[0], string, boolean]>([
    ["another member's routine", { routineOwner: "user-2" }, "FORBIDDEN", false],
    ["a routine on another member's bot", { botOwner: "user-2" }, "BAD_REQUEST", false],
    ["an owner with no computer paired", { paired: false }, "BAD_REQUEST", false],
    ["a routine that runs in its chat", { inChat: true }, "BAD_REQUEST", true],
    ["a routine that watches", { watch: { kind: "files", paths: ["~"] } }, "BAD_REQUEST", true],
  ])("is refused for %s", async (_label, options, code, shownOff) => {
    const h = harness(options);
    await expect(
      h.client.routines.update({ routineId: "routine-1", useComputer: true }),
    ).rejects.toMatchObject({ code });
    expect(h.saved).toEqual([]);
    const [view] = await h.client.routines.list({ botId: "bot-1" });
    // Shown off where the owner could change the routine to allow it; otherwise not offered.
    if (shownOff) expect(view?.useComputer).toBe(false);
    else expect(view).not.toHaveProperty("useComputer");
  });

  it("is never carried to a new routine or its copy", async () => {
    const h = harness();
    await h.client.routines.create({
      botId: "bot-1",
      name: "Copy",
      prompt: "@backups every night",
      crons: ["0 9 * * *"],
      active: false,
      useComputer: true,
    } as Parameters<typeof h.client.routines.create>[0]);
    expect(h.saved.at(-1)).not.toHaveProperty("computerPromptHash");
  });
});
