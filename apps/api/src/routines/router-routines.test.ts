import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { appHandler, createRouter, handle } from "../router-test-support.js";

describe("routine live Codex model validation", () => {
  it.each(["create", "update"] as const)(
    "saves a listed live-only model on %s and rejects an unlisted id",
    async (operation) => {
      const actor = { userId: "user-1", spaceId: "space-1", email: "user@rakazo.test" };
      const modelId = "gpt-6-luna-latest";
      const stamp = new Date("2026-01-01T00:00:00Z");
      const row = {
        id: "routine-1",
        botId: "bot-1",
        name: "Check",
        prompt: "Check changes",
        crons: ["0 9 * * *"],
        timezone: "UTC",
        active: false,
        notify: false,
        webhookEnabled: false,
        githubEnabled: false,
        messageProvider: null,
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        lastRunAt: null,
        nextRunAt: null,
        createdAt: stamp,
      };
      const save = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...row,
        ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
      }));
      const read = vi.fn(async () => [
        {
          slug: modelId,
          reasoningEfforts: [],
          supportsImages: true,
          supportsFastTier: false,
        },
      ]);
      const client = createRouterClient(
        createRouter({
          prisma: {
            bot: { findFirst: vi.fn(async () => ({ id: "bot-1", computer: null })) },
            routine: {
              findFirst: vi.fn(async () => row),
              create: save,
              update: save,
              count: vi.fn(async () => 0),
            },
            run: { updateManyAndReturn: vi.fn(async () => []) },
            userModelPreference: { findMany: vi.fn(async () => []) },
            userModelCredential: {
              findMany: vi.fn(async () => [
                {
                  id: "credential-1",
                  provider: "openai-codex",
                  secretId: "secret-1",
                  updatedAt: stamp,
                  createdAt: stamp,
                },
              ]),
            },
            secret: {
              findFirst: vi.fn(async () => ({ id: "secret-1", ciphertext: "fake-cipher" })),
            },
          },
          secrets: {
            load: vi.fn(async () =>
              JSON.stringify({
                type: "oauth",
                access: "fake-access",
                refresh: "fake-refresh",
                expires: Date.now() + 60_000,
                accountId: "acct-test",
              }),
            ),
          },
          jobs: { cancel: vi.fn(async () => undefined) },
          codexCatalog: { read },
          env: { sandboxProvider: "fake" },
        } as unknown as RouterDeps),
        { context: { actor } as never },
      );
      const call = (id: string) =>
        operation === "create"
          ? client.routines.create({
              botId: "bot-1",
              name: "Check",
              prompt: "Check changes",
              crons: ["0 9 * * *"],
              active: false,
              modelProvider: "openai-codex",
              modelId: id,
            })
          : client.routines.update({
              routineId: "routine-1",
              modelProvider: "openai-codex",
              modelId: id,
            });

      await expect(call(modelId)).resolves.toMatchObject({
        modelProvider: "openai-codex",
        modelId,
      });
      expect(read).toHaveBeenCalledWith(
        actor.userId,
        expect.objectContaining({ accountId: "acct-test" }),
        undefined,
      );
      expect(save).toHaveBeenCalledOnce();
      await expect(call("gpt-6-luna-unlisted")).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Unknown model for that provider",
      });
      expect(save).toHaveBeenCalledOnce();
    },
  );
});

describe("routines.list", () => {
  it("lets every Space member change a routine, whoever created it", async () => {
    const actor = { userId: "user-1", spaceId: "space-1" };
    const row = (id: string, userId: string) => ({
      id,
      botId: "bot-1",
      spaceId: "space-1",
      userId,
      name: id,
      prompt: "Check changes",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: true,
      notify: false,
      webhookEnabled: false,
      githubEnabled: false,
      messageProvider: null,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      watch: null,
      watchState: null,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    const client = createRouterClient(
      createRouter({
        prisma: {
          bot: { findFirst: vi.fn(async () => ({ id: "bot-1", thread: null, computer: null })) },
          routine: {
            findMany: vi.fn(async () => [row("mine", "user-1"), row("theirs", "user-2")]),
          },
        },
        env: { sandboxProvider: "fake" },
      } as unknown as RouterDeps),
      { context: { actor } as never },
    );

    const routines = await client.routines.list({ botId: "bot-1" });
    // Nothing marks either one read-only: any member may change it.
    expect(routines.map(({ id, editable }) => ({ id, editable }))).toEqual([
      { id: "mine", editable: undefined },
      { id: "theirs", editable: undefined },
    ]);
    expect(routines[0]).not.toHaveProperty("userId");
  });
});

describe("routines.update", () => {
  const actor = {
    spaceId: "space-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const routine = {
    id: "routine-1",
    botId: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    name: "Later",
    prompt: "say done",
    crons: ["@once"],
    timezone: "UTC",
    active: false,
    notify: false,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  };

  function fixture(
    botArchived: boolean,
    archivedBeforeWrite = false,
    model: Record<string, unknown> = {},
  ) {
    const savedRoutine: Record<string, unknown> = { ...routine, ...model };
    const update = vi.fn(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (archivedBeforeWrite) throw Object.assign(new Error("not found"), { code: "P2025" });
        return {
          ...savedRoutine,
          ...Object.fromEntries(
            Object.entries(args.data).filter(([, value]) => value !== undefined),
          ),
        };
      },
    );
    const enqueue = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const moveQueued = vi.fn(async (_args: unknown) => [] as Array<{ taskId: string }>);
    const prisma = {
      secret: { findFirst: vi.fn(async () => null) },
      userModelPreference: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => ({ id: "preference-1" })),
      },
      userModelCredential: {
        findMany: vi.fn(async () => [
          {
            id: "credential-1",
            provider: "openai-compatible",
            apiKey: "fake-key",
            userId: actor.userId,
          },
        ]),
      },
      routine: {
        findFirst: vi.fn(async (args: { where: { bot?: { archivedAt: null } } }) =>
          botArchived && args.where.bot?.archivedAt === null ? null : savedRoutine,
        ),
        update,
        count: vi.fn(async () => 0),
      },
      run: { updateManyAndReturn: moveQueued },
      bot: {
        findFirst: vi.fn(async () =>
          botArchived ? null : { id: "bot-1", thread: { id: "thread-1" }, computer: null },
        ),
      },
    };
    const handler = appHandler({
      prisma,
      env: { sandboxProvider: "fake" },
      events: { append: vi.fn(async () => undefined) },
      jobs: { enqueue, cancel },
    } as unknown as RouterDeps);
    const call = (patch: Record<string, unknown> = {}) =>
      handle(
        handler,
        new Request("http://127.0.0.1/rpc/routines/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json: {
              routineId: "routine-1",
              active: true,
              runAt: new Date(Date.now() + 60_000).toISOString(),
              ...patch,
            },
          }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
    return { update, enqueue, cancel, call, moveQueued, findFirst: prisma.routine.findFirst };
  }

  it("refuses to re-arm a routine on an archived bot without writing", async () => {
    const { update, enqueue, call } = fixture(true);
    const response = await call();
    expect(response.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("re-arms a routine on an active bot", async () => {
    const { update, enqueue, call } = fixture(false);
    const response = await call();
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "routine-1", bot: { archivedAt: null }, nextRunAt: null, active: false },
        data: expect.objectContaining({ active: true }),
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("does not re-arm when the bot is archived between the read and the write", async () => {
    const { enqueue, call, findFirst } = fixture(false, true);
    findFirst.mockResolvedValueOnce(routine).mockResolvedValueOnce(null);
    const response = await call();
    expect(response.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("takes over a routine and restarts its watch baseline when someone else edits it", async () => {
    const { call, update, moveQueued } = fixture(false, false, { userId: "user-2" });
    expect((await call({ name: "Renamed" })).status).toBe(200);
    const data = update.mock.calls[0]![0].data;
    expect(data.userId).toBe("user-1");
    expect(data).toHaveProperty("watchState", Prisma.DbNull);
    // An occurrence already queued runs with the new owner's accounts.
    expect(moveQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          routineId: routine.id,
          userId: "user-2",
          status: "queued",
          routine: { userId: "user-1" },
        },
        data: { userId: "user-1" },
      }),
    );
  });

  it("keeps its watch baseline when the owner edits it", async () => {
    const { call, update } = fixture(false);
    expect((await call({ name: "Renamed" })).status).toBe(200);
    expect(update.mock.calls[0]![0].data).not.toHaveProperty("watchState");
  });

  const ownModel = {
    modelProvider: "openai-compatible",
    modelId: "old-model",
    thinkingLevel: "high",
  };

  it("leaves model columns out of unrelated updates", async () => {
    const { call, update } = fixture(false, false, ownModel);
    expect((await call({ name: "Renamed", active: undefined, runAt: undefined })).status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "routine-1", bot: { archivedAt: null } } }),
    );
    const data = update.mock.calls[0]![0].data;
    for (const column of ["modelProvider", "modelId", "thinkingLevel"])
      expect(data).not.toHaveProperty(column);
  });

  it.each(["modelProvider", "modelId", "thinkingLevel"])(
    "rejects a partial model patch when %s changes before the write",
    async (column) => {
      const { call, update, enqueue } = fixture(false, false, ownModel);
      update.mockImplementationOnce(async (args) => {
        const current: Record<string, unknown> = { ...ownModel, [column]: "concurrent-choice" };
        expect(args.where).toMatchObject(ownModel);
        if (args.where[column] !== current[column]) {
          throw Object.assign(new Error("not found"), { code: "P2025" });
        }
        throw new Error("Concurrent model change was not guarded");
      });
      expect((await call({ thinkingLevel: "low" })).status).toBe(409);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it("returns not found if a model update races with a parent archive", async () => {
    const { call, findFirst } = fixture(false, true, ownModel);
    findFirst.mockResolvedValueOnce({ ...routine, ...ownModel }).mockResolvedValueOnce(null);
    expect((await call({ thinkingLevel: "low" })).status).toBe(404);
  });

  it("merges a model-id-only patch with the saved provider and clears old thinking", async () => {
    const { call, update } = fixture(false, false, ownModel);
    expect((await call({ modelId: "new-model" })).status).toBe(200);
    expect(update.mock.calls[0]![0].data).toMatchObject({
      modelProvider: "openai-compatible",
      modelId: "new-model",
      thinkingLevel: null,
    });
  });

  it("merges a provider-only patch with the saved model and clears old thinking", async () => {
    const { call, update } = fixture(false, false, { ...ownModel, modelProvider: "openrouter" });
    expect((await call({ modelProvider: "openai-compatible" })).status).toBe(200);
    expect(update.mock.calls[0]![0].data).toMatchObject({
      modelProvider: "openai-compatible",
      modelId: "old-model",
      thinkingLevel: null,
    });
  });

  it("keeps thinking when the saved Azure provider alias is canonicalized", async () => {
    const { call, update } = fixture(false, false, {
      modelProvider: "azure-openai-responses",
      modelId: "gpt-4o",
      thinkingLevel: "high",
    });
    expect((await call({ modelProvider: "azure", modelId: "gpt-4o" })).status).toBe(200);
    expect(update.mock.calls[0]![0].data).toMatchObject({
      modelProvider: "azure",
      modelId: "gpt-4o",
      thinkingLevel: "high",
    });
  });

  it("keeps an explicitly supplied thinking level when changing models", async () => {
    const { call, update } = fixture(false, false, ownModel);
    expect((await call({ modelId: "new-model", thinkingLevel: "low" })).status).toBe(200);
    expect(update.mock.calls[0]![0].data).toMatchObject({ thinkingLevel: "low" });
  });

  it("rejects a partial patch whose resulting model is incomplete", async () => {
    const { call, update } = fixture(false, false, ownModel);
    expect((await call({ modelId: null })).status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects thinking without a resulting model", async () => {
    const { call, update } = fixture(false);
    expect((await call({ thinkingLevel: "high" })).status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  const recurring = {
    crons: ["0 9 * * *"],
    active: true,
    nextRunAt: new Date("2026-09-02T09:00:00.000Z"),
  };

  it("leaves the schedule alone when an edit does not change it", async () => {
    const { call, update, enqueue } = fixture(false, false, recurring);
    expect((await call({ name: "Renamed", runAt: undefined })).status).toBe(200);
    expect(update.mock.calls[0]![0].data).not.toHaveProperty("nextRunAt");
    expect(update.mock.calls[0]![0].where).not.toHaveProperty("nextRunAt");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("keeps a schedule that a concurrent enable armed while renaming", async () => {
    const armedAt = new Date("2026-09-02T09:00:00.000Z");
    const { call, update, enqueue, cancel } = fixture(false, false, {
      crons: ["0 9 * * *"],
    });
    // The enable commits between the read and the write, so the row the
    // update returns already carries the schedule it armed. The rename must
    // keep that schedule instead of cancelling the armed wakeup.
    update.mockImplementationOnce(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
        ...routine,
        crons: ["0 9 * * *"],
        active: true,
        nextRunAt: armedAt,
        ...Object.fromEntries(Object.entries(args.data).filter(([, value]) => value !== undefined)),
      }),
    );
    const response = await call({ name: "Renamed", active: undefined, runAt: undefined });
    expect(response.status).toBe(200);
    expect(update.mock.calls[0]![0].data).not.toHaveProperty("nextRunAt");
    expect(update.mock.calls[0]![0].where).not.toHaveProperty("nextRunAt");
    expect(cancel).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      name: "routine.wakeup",
      payload: { routineId: "routine-1", scheduledFor: armedAt.toISOString() },
      availableAt: armedAt,
      replaceKey: "routine:routine-1",
    });
    await expect(response.json()).resolves.toMatchObject({
      json: { name: "Renamed", active: true, nextRunAt: armedAt.toISOString() },
    });
  });

  it("rejects a schedule change when an enable landed after the read", async () => {
    // The editor omits an unchanged on/off; the new schedule was computed for a paused routine.
    const { call, update, enqueue } = fixture(false, false, { crons: ["0 9 * * *"] });
    update.mockImplementationOnce(async (args) => {
      expect(args.where).toMatchObject({ active: false });
      throw Object.assign(new Error("not found"), { code: "P2025" });
    });
    expect(
      (await call({ crons: ["0 10 * * *"], active: undefined, runAt: undefined })).status,
    ).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects an explicit on/off when a disable landed after the read", async () => {
    // The editor sends `active` with every save. A disable that commits between the read and
    // the write must not be undone by a rename that still says "on".
    const { call, update, enqueue, cancel } = fixture(false, false, recurring);
    update.mockImplementationOnce(async (args) => {
      expect(args.where).toMatchObject({ active: true });
      throw Object.assign(new Error("not found"), { code: "P2025" });
    });
    expect((await call({ name: "Renamed", active: true, runAt: undefined })).status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("rejects a schedule change when the routine fired after the read", async () => {
    const { call, update, enqueue } = fixture(false, false, recurring);
    update.mockImplementationOnce(async (args) => {
      expect(args.where).toMatchObject({ nextRunAt: recurring.nextRunAt });
      throw Object.assign(new Error("not found"), { code: "P2025" });
    });
    expect((await call({ crons: ["0 10 * * *"], runAt: undefined })).status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("routines.remove", () => {
  function fixture() {
    const routine = { id: "routine-1", botId: "bot-1", spaceId: "space-1", userId: "user-a" };
    const remove = vi.fn(async () => routine);
    const cancel = vi.fn(async () => undefined);
    const router = createRouter({
      prisma: {
        routine: {
          findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
            Object.entries(where).every(
              ([key, value]) => routine[key as keyof typeof routine] === value,
            )
              ? routine
              : null,
          ),
          delete: remove,
        },
      },
      env: { sandboxProvider: "fake" },
      jobs: { cancel },
    } as unknown as RouterDeps);
    const as = (userId: string, spaceId = "space-1") =>
      createRouterClient(router, {
        context: { actor: { spaceId, userId } } as never,
      });
    return { as, remove, cancel };
  }

  it("lets another Space member delete a routine, but nobody outside the Space", async () => {
    const { as, remove, cancel } = fixture();
    await expect(
      as("user-c", "space-2").routines.remove({ routineId: "routine-1" }),
    ).rejects.toThrow();
    expect(remove).not.toHaveBeenCalled();
    await expect(as("user-b").routines.remove({ routineId: "routine-1" })).resolves.toEqual({
      ok: true,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("deletes the owner's routine", async () => {
    const { as, remove, cancel } = fixture();
    await expect(as("user-a").routines.remove({ routineId: "routine-1" })).resolves.toEqual({
      ok: true,
    });
    expect(remove).toHaveBeenCalledWith({ where: { id: "routine-1" } });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("routine watch creation boundaries", () => {
  const actor = {
    spaceId: "space-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;

  function fixture() {
    const create = vi.fn();
    const update = vi.fn();
    const findBot = vi.fn(async () => ({ id: "bot-1", computer: { scope: "team" } }));
    const findRoutine = vi.fn(async () => ({
      id: "routine-1",
      botId: "bot-1",
      crons: [],
      watch: null,
    }));
    const deps = {
      prisma: {
        bot: { findFirst: findBot },
        routine: { findFirst: findRoutine, create, update },
      },
      env: { sandboxProvider: "fake" },
    } as unknown as RouterDeps;
    const client = createRouterClient(createRouter(deps), { context: { actor } as never });
    const handler = appHandler(deps);
    /** What the app answers, for the create and then the update of a routine with this watch. */
    const answers = async (watch: Record<string, unknown>) => {
      const calls = [
        ["create", { botId: "bot-1", name: "Check", prompt: "Check changes", watch }],
        ["update", { routineId: "routine-1", watch }],
      ] as const;
      const responses = [];
      for (const [procedure, json] of calls) {
        const response = await handle(
          handler,
          new Request(`http://127.0.0.1/rpc/routines/${procedure}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json }),
          }),
          { prefix: "/rpc", context: { actor } },
        );
        responses.push({ status: response.status, body: await response.text() });
      }
      return responses;
    };
    return { client, create, update, findBot, findRoutine, answers };
  }

  it("rejects team file escapes on create and update before writing", async () => {
    const { client, create, update } = fixture();
    const watch = { kind: "files" as const, paths: ["/etc"], everyMinutes: 5, loud: false };
    await expect(
      client.routines.create({ botId: "bot-1", name: "Check", prompt: "Check changes", watch }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("inside the bot's folder"),
    });
    await expect(client.routines.update({ routineId: "routine-1", watch })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("inside the bot's folder"),
    });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("answers a watched path outside the bot's folder as the caller's to fix", async () => {
    const { answers, create, update } = fixture();
    const watch = { kind: "files", paths: ["/etc"], everyMinutes: 5, loud: false };
    for (const { status, body } of await answers(watch)) {
      expect(status).toBe(400);
      expect(JSON.parse(body).json).toMatchObject({
        code: "BAD_REQUEST",
        message: "The watched path must stay inside the bot's folder.",
      });
    }
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("reports a failure to check the watch as a server fault, without its message", async () => {
    const { answers, create, update, findBot } = fixture();
    findBot.mockResolvedValue({ id: "bot-1", computer: { scope: "mainframe" } });
    const watch = { kind: "files", paths: ["notes"], everyMinutes: 5, loud: false };
    for (const { status, body } of await answers(watch)) {
      expect(status).toBe(500);
      expect(body).not.toContain("mainframe");
    }
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("uses the space boundary before creating or changing a command watch", async () => {
    const { client, create, update, findBot, findRoutine } = fixture();
    findBot.mockResolvedValueOnce(null as never);
    const watch = {
      kind: "command" as const,
      command: "echo changed",
      everyMinutes: 5,
      loud: false,
    };
    await expect(
      client.routines.create({ botId: "bot-1", name: "Check", prompt: "Check changes", watch }),
    ).rejects.toBeDefined();
    expect(findBot).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ spaceId: actor.spaceId }),
      }),
    );
    findRoutine.mockResolvedValueOnce(null as never);
    await expect(client.routines.update({ routineId: "routine-1", watch })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(findRoutine).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ spaceId: actor.spaceId }),
      }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
