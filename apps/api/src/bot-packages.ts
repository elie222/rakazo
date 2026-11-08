import { createHash, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
  BotPackageError,
  BUILTIN_AGENT_SKILLS,
  parseBotPackageSource,
  prepareBotPackageDocument,
} from "@rakazo/adapters";
import type {
  Actor,
  BotPackageActivateSkillInput,
  BotPackageExportInput,
  BotPackageImportInput,
  BotPackageLeftOut,
  BotPackagePreviewInput,
  BotPackageReceipt,
  BotPackageRecentReceipt,
} from "@rakazo/contracts";
import {
  BOT_PACKAGE_FORMAT,
  BotPackageDocumentSchema,
  BotPackageLeftOutSchema,
} from "@rakazo/contracts";
import { isOneShotRoutineCron } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import {
  ComputerLimitError,
  createRepos,
  isUniqueViolation,
  lockSpaceForContentCreation,
  SpaceDeletionInProgressError,
  Prisma as Sql,
  withTransactionRetry,
} from "@rakazo/db";
import { redactSecretText } from "@rakazo/logging";
import { resolveSkillContent } from "./agent-skills.js";
import { assertNameFreeWhereAvailable, userAddedAvailability } from "./availability.js";
import type { RouterDeps } from "./router.js";

type Context = {
  actor: Actor;
  sessionId?: string;
  signal?: AbortSignal;
  stillAuthorized?: () => Promise<boolean>;
};
type Deps = Pick<RouterDeps, "prisma">;
const includeChildren = {
  bot: { select: { archivedAt: true } },
  components: { orderBy: { key: "asc" as const } },
} as const;
type Row = Prisma.BotPackageImportGetPayload<{ include: typeof includeChildren }>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fleetTools = [
  "run_subagent",
  "create_space",
  "spawn_bot",
  "update_bot",
  "archive_bot",
  "message_bot",
  "handoff_to_bot",
  "connect_agent",
  "respond_agent_connection",
  "message_agent",
  "cloud_agent_launch",
  "cloud_agent_status",
  "cloud_agent_reply",
  "cloud_agent_cancel",
];

/**
 * Skills from a plugin install count unless the install itself is a plugin
 * install. This install table has no liveness columns, so there is no
 * tombstone check beyond the install kind.
 */
const activePluginSkillWhere: Prisma.AgentSkillWhereInput = {
  OR: [{ installId: null }, { install: { is: { kind: { not: "plugin" } } } }],
};

function mapSpaceLifecycleError(error: unknown): unknown {
  if (error instanceof SpaceDeletionInProgressError) {
    return new ORPCError("CONFLICT", { message: error.message });
  }
  if (error instanceof ComputerLimitError) {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }
  return error;
}

async function authorized(context: Context) {
  context.signal?.throwIfAborted();
  if (context.stillAuthorized && !(await context.stillAuthorized()))
    throw new ORPCError("UNAUTHORIZED");
}
async function lockScope(tx: Prisma.TransactionClient, context: Context) {
  const { userId, spaceId } = context.actor;
  await lockSpaceForContentCreation(tx, { userId, spaceId });
  const users = await tx.$queryRaw<Array<{ id: string }>>(
    Sql.sql`SELECT id FROM "user" WHERE id=${userId} FOR SHARE`,
  );
  const spaces = await tx.$queryRaw<Array<{ id: string }>>(
    Sql.sql`SELECT id FROM spaces WHERE id=${spaceId} AND "deletingAt" IS NULL FOR SHARE`,
  );
  const members = await tx.$queryRaw<Array<{ id: string }>>(
    Sql.sql`SELECT id FROM space_members WHERE "spaceId"=${spaceId} AND "userId"=${userId} FOR SHARE`,
  );
  if (!users.length || !spaces.length || !members.length) throw new ORPCError("FORBIDDEN");
  if (context.sessionId) {
    const sessions = await tx.$queryRaw<Array<{ id: string }>>(
      Sql.sql`SELECT id FROM "session" WHERE id=${context.sessionId} AND "userId"=${userId} AND "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') FOR SHARE`,
    );
    if (!sessions.length) throw new ORPCError("UNAUTHORIZED");
  }
  context.signal?.throwIfAborted();
}
function safeLeftOut(value: unknown): BotPackageLeftOut[] {
  const result = BotPackageLeftOutSchema.array().safeParse(value);
  return result.success ? result.data : [];
}
function packageError(error: unknown): never {
  if (error instanceof BotPackageError)
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  throw error;
}
const note = (
  name: string,
  reason: string,
  kind: BotPackageLeftOut["kind"] = "unsupported",
): BotPackageLeftOut => ({ kind, name, reason });
const own = (actor: Actor) => ({ spaceId: actor.spaceId, userId: actor.userId });

/** JSON-only packages never call home, credentials, provisioning, or the job publisher. */
export function createBotPackagesService(deps: Deps) {
  const findNonce = (actor: Actor, clientNonce: string) =>
    deps.prisma.botPackageImport.findUnique({
      where: { spaceId_userId_clientNonce: { ...own(actor), clientNonce } },
      include: includeChildren,
    });
  async function scope(context: Context) {
    await authorized(context);
    const member = await deps.prisma.spaceMember.findUnique({
      where: { spaceId_userId: own(context.actor) },
      select: { space: { select: { deletingAt: true } } },
    });
    if (!member || member.space.deletingAt) throw new ORPCError("FORBIDDEN");
    // Authorization expiry is independent of physical retention. Each package request
    // reclaims a bounded batch across actors without retaining content in logs.
    const expired = await deps.prisma.botPackagePreview.findMany({
      where: { expiresAt: { lte: new Date() } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: 32,
      select: { id: true },
    });
    if (expired.length)
      await deps.prisma.botPackagePreview.deleteMany({
        where: { id: { in: expired.map((row) => row.id) }, expiresAt: { lte: new Date() } },
      });
  }
  async function receipt(actor: Actor, row: Row): Promise<BotPackageReceipt> {
    const removed =
      row.status === "completed" && (!row.botId || !row.bot || row.bot.archivedAt !== null);
    const targetIds = row.components.flatMap((component) =>
      component.targetSkillId ? [component.targetSkillId] : [],
    );
    const targets = targetIds.length
      ? await deps.prisma.agentSkill.findMany({
          where: {
            ...own(actor),
            ...activePluginSkillWhere,
            source: { in: ["user", "plugin"] },
            id: { in: targetIds },
          },
          select: { id: true, name: true, description: true },
        })
      : [];
    const targetById = new Map(targets.map((skill) => [skill.id, skill]));
    return {
      importId: row.id,
      clientNonce: row.clientNonce,
      digest: row.digest,
      status: removed ? "removed" : (row.status as BotPackageReceipt["status"]),
      revision: row.revision,
      botId: removed ? null : row.botId,
      botName: redactSecretText(row.botName),
      createdAt: row.createdAt.toISOString(),
      skills: removed
        ? []
        : row.components
            .filter((component) => component.kind === "skill")
            .map((component) => {
              const target = component.targetSkillId
                ? targetById.get(component.targetSkillId)
                : undefined;
              const status =
                component.status === "activated" ? (target ? "activated" : "removed") : "pending";
              return {
                id: component.id,
                key: component.key,
                name: redactSecretText(target?.name ?? component.name),
                description: redactSecretText(target?.description ?? component.description),
                content: status !== "pending" ? null : redactSecretText(component.content ?? ""),
                status,
                revision: component.revision,
                skillId: component.targetSkillId,
              };
            }),
      connections: removed
        ? []
        : row.components
            .filter((component) => component.kind === "connection")
            .map((component) => ({
              id: component.id,
              key: component.key,
              name: component.name,
              note: component.description,
            })),
      leftOut: safeLeftOut(row.leftOut),
    };
  }
  async function transact<T>(context: Context, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    await authorized(context);
    return withTransactionRetry(() =>
      deps.prisma.$transaction(
        async (tx) => {
          await lockScope(tx, context);
          const value = await fn(tx);
          await authorized(context);
          return value;
        },
        { timeout: 30_000 },
      ),
    ).catch((error: unknown) => {
      throw mapSpaceLifecycleError(error);
    });
  }
  async function lockedNonce(tx: Prisma.TransactionClient, actor: Actor, clientNonce: string) {
    // The Space lifecycle lock also serializes absent nonces and cancellation tombstones.
    await tx.$queryRaw(
      Sql.sql`SELECT id FROM bot_package_imports WHERE "spaceId"=${actor.spaceId} AND "userId"=${actor.userId} AND "clientNonce"=${clientNonce} FOR UPDATE`,
    );
    return tx.botPackageImport.findUnique({
      where: { spaceId_userId_clientNonce: { ...own(actor), clientNonce } },
      include: includeChildren,
    });
  }
  async function finish(context: Context, clientNonce: string) {
    // Phase one: lock the marker and validate it. Phase two creates the bot
    // through createRepos, whose seed writes the package contents in the same
    // transaction as the bot and claims the marker; a concurrent finish loses
    // the claim, rolls its bot back, and reads the winner's receipt below.
    try {
      const marker = await transact(context, async (tx) => {
        const row = await lockedNonce(tx, context.actor, clientNonce);
        if (!row) throw new ORPCError("NOT_FOUND");
        if (row.status !== "importing" && row.status !== "failed") return row;
        if (row.botId || !row.plan)
          throw new ORPCError("CONFLICT", { message: "This import cannot be resumed." });
        return row;
      });
      if (marker.status !== "importing" && marker.status !== "failed")
        return receipt(context.actor, marker);
      const document = BotPackageDocumentSchema.parse(marker.plan);
      await createRepos(deps.prisma).createBot(context.actor, {
        // This Bot model has no title column; the profile keeps the field so
        // packages stay portable, and the title is dropped on import.
        name: document.profile.name,
        description: document.profile.description,
        instructions: document.profile.instructions,
        color: document.profile.color,
        notifyOnFinish: false,
        disabledBuiltinTools: fleetTools,
        seed: async (tx, botId) => {
          const thread = await tx.thread.findFirstOrThrow({ where: { botId } });
          if (document.routines.length)
            await tx.routine.createMany({
              data: document.routines.map((routine) => ({
                ...routine,
                ...own(context.actor),
                botId,
                threadId: thread.id,
                active: false,
                notify: false,
              })),
            });
          const components: Prisma.BotPackageComponentCreateManyInput[] = [
            ...document.skills.map((skill, index) => ({
              ...skill,
              importId: marker.id,
              botId,
              key: `skill:${index}`,
              kind: "skill",
            })),
            ...document.connections.map((connection, index) => ({
              importId: marker.id,
              botId,
              key: `connection:${index}`,
              kind: "connection",
              name: connection.name,
              description: connection.note,
            })),
          ];
          if (components.length) await tx.botPackageComponent.createMany({ data: components });
          if (document.memory.length) {
            await tx.memoryDocument.deleteMany({
              where: { ...own(context.actor), botId, scope: "bot" },
            });
            for (const memory of document.memory)
              await tx.memoryDocument.create({
                data: {
                  ...memory,
                  ...own(context.actor),
                  botId,
                  scope: "bot",
                  revisions: { create: { revision: 1, content: memory.content } },
                },
              });
          }
          await tx.bot.update({ where: { id: botId }, data: { memoryScope: "isolated" } });
          const claimed = await tx.botPackageImport.updateMany({
            where: { id: marker.id, status: { in: ["importing", "failed"] }, botId: null },
            data: {
              status: "completed",
              botId,
              plan: Sql.DbNull,
              revision: { increment: 1 },
            },
          });
          if (claimed.count === 0) throw new Error("This import was already completed.");
        },
      });
      const row = await deps.prisma.botPackageImport.findUniqueOrThrow({
        where: { id: marker.id },
        include: includeChildren,
      });
      return receipt(context.actor, row);
    } catch (error) {
      // An acknowledgement failure may follow a successful commit. Never turn it into a new write.
      await deps.prisma.botPackageImport
        .updateMany({
          where: { ...own(context.actor), clientNonce, status: "importing", botId: null },
          data: { status: "failed", revision: { increment: 1 } },
        })
        .catch(() => undefined);
      const recovered = await findNonce(context.actor, clientNonce).catch(() => null);
      if (recovered && (recovered.status === "completed" || recovered.status === "cancelled")) {
        await scope(context);
        return receipt(context.actor, recovered);
      }
      throw mapSpaceLifecycleError(error);
    }
  }
  return {
    async preview(context: Context, input: BotPackagePreviewInput) {
      await scope(context);
      const user = await deps.prisma.user.findUnique({
        where: { id: context.actor.userId },
        select: { timezone: true },
      });
      let parsed: ReturnType<typeof parseBotPackageSource>;
      try {
        parsed = parseBotPackageSource(input.source, {
          ...input,
          defaultTimezone: user?.timezone ?? "UTC",
        });
      } catch (error) {
        return packageError(error);
      }
      const previewToken = randomBytes(32).toString("base64url");
      const digest = hash(parsed.json);
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      await transact(context, async (tx) => {
        await tx.botPackagePreview.create({
          data: {
            ...own(context.actor),
            tokenHash: hash(previewToken),
            digest,
            sourceFormat: parsed.sourceFormat,
            document: parsed.document,
            leftOut: parsed.leftOut,
            includeMemory: input.includeMemory,
            availableMemoryCount: parsed.availableMemoryCount,
            expiresAt,
          },
        });
      });
      return {
        previewToken,
        digest,
        expiresAt: expiresAt.toISOString(),
        document: parsed.document,
        sourceFormat: parsed.sourceFormat,
        leftOut: parsed.leftOut,
        availableMemoryCount: parsed.availableMemoryCount,
        includeMemory: input.includeMemory,
      };
    },
    async import(context: Context, input: BotPackageImportInput) {
      await scope(context);
      const tokenHash = hash(input.previewToken);
      let existing = await findNonce(context.actor, input.clientNonce);
      existing = await transact(context, async (tx) => {
        const prior = await lockedNonce(tx, context.actor, input.clientNonce);
        if (prior) {
          if (prior.status !== "cancelled" && prior.previewTokenHash !== tokenHash)
            throw new ORPCError("CONFLICT", {
              message: "This request was already used for different content.",
            });
          return prior;
        }
        await tx.$queryRaw(
          Sql.sql`SELECT id FROM bot_package_previews WHERE "tokenHash"=${tokenHash} FOR UPDATE`,
        );
        const preview = await tx.botPackagePreview.findFirst({
          where: { ...own(context.actor), tokenHash, expiresAt: { gt: new Date() } },
        });
        if (!preview)
          throw new ORPCError("BAD_REQUEST", {
            message: "This preview expired. Preview the file again.",
          });
        const consumed = await tx.botPackageImport.findUnique({
          where: { previewTokenHash: tokenHash },
        });
        if (consumed)
          throw new ORPCError("CONFLICT", {
            message: "This preview already belongs to another import request.",
          });
        const document = BotPackageDocumentSchema.parse(preview.document);
        const marker = await tx.botPackageImport.create({
          data: {
            ...own(context.actor),
            clientNonce: input.clientNonce,
            previewTokenHash: tokenHash,
            digest: preview.digest,
            botName: document.profile.name,
            plan: preview.document as Prisma.InputJsonValue,
            leftOut: preview.leftOut as Prisma.InputJsonValue,
            skillCount: document.skills.length,
            connectionCount: document.connections.length,
          },
          include: includeChildren,
        });
        await tx.botPackagePreview.delete({ where: { id: preview.id } });
        return marker;
      });
      if (existing.status !== "importing" && existing.status !== "failed")
        return receipt(context.actor, existing);
      return finish(context, input.clientNonce);
    },
    async status(context: Context, input: { clientNonce: string }) {
      await scope(context);
      const row = await findNonce(context.actor, input.clientNonce);
      return row ? receipt(context.actor, row) : null;
    },
    async recent(context: Context): Promise<BotPackageRecentReceipt[]> {
      await scope(context);
      const rows = await deps.prisma.botPackageImport.findMany({
        where: own(context.actor),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20,
        select: {
          id: true,
          clientNonce: true,
          status: true,
          revision: true,
          botId: true,
          botName: true,
          createdAt: true,
          skillCount: true,
          connectionCount: true,
          bot: { select: { archivedAt: true } },
        },
      });
      return rows.map((row) => ({
        importId: row.id,
        clientNonce: row.clientNonce,
        status:
          row.status === "completed" && (!row.bot || row.bot.archivedAt)
            ? "removed"
            : (row.status as BotPackageRecentReceipt["status"]),
        revision: row.revision,
        botId: row.bot?.archivedAt ? null : row.botId,
        botName: redactSecretText(row.botName),
        createdAt: row.createdAt.toISOString(),
        skillCount: row.skillCount,
        connectionCount: row.connectionCount,
      }));
    },
    async forBot(context: Context, input: { botId: string }) {
      await scope(context);
      const bot = await deps.prisma.bot.findFirst({
        where: { ...own(context.actor), id: input.botId, archivedAt: null },
        select: { id: true },
      });
      if (!bot) throw new ORPCError("NOT_FOUND");
      const row = await deps.prisma.botPackageImport.findFirst({
        where: { ...own(context.actor), botId: bot.id },
        include: includeChildren,
      });
      return row ? receipt(context.actor, row) : null;
    },
    async resume(context: Context, input: { clientNonce: string }) {
      await scope(context);
      const row = await findNonce(context.actor, input.clientNonce);
      if (!row) throw new ORPCError("NOT_FOUND");
      if (row.status !== "importing" && row.status !== "failed") return receipt(context.actor, row);
      return finish(context, input.clientNonce);
    },
    async cancel(context: Context, input: { clientNonce: string }) {
      await scope(context);
      const row = await transact(context, async (tx) => {
        const prior = await lockedNonce(tx, context.actor, input.clientNonce);
        if (!prior)
          return tx.botPackageImport.create({
            data: { ...own(context.actor), clientNonce: input.clientNonce, status: "cancelled" },
            include: includeChildren,
          });
        if (prior.status !== "importing" && prior.status !== "failed") return prior;
        return tx.botPackageImport.update({
          where: { id: prior.id },
          data: { status: "cancelled", plan: Sql.DbNull, revision: { increment: 1 } },
          include: includeChildren,
        });
      });
      return receipt(context.actor, row);
    },
    async activateSkill(context: Context, input: BotPackageActivateSkillInput) {
      await scope(context);
      const binding = hash(JSON.stringify([input.expectedRevision, input.name ?? null]));
      const row = await transact(context, async (tx) => {
        const component = await tx.botPackageComponent.findFirst({
          where: {
            id: input.componentId,
            kind: "skill",
            import: own(context.actor),
            bot: { ...own(context.actor), archivedAt: null },
          },
          include: { import: true },
        });
        if (component?.import.status !== "completed") throw new ORPCError("NOT_FOUND");
        await tx.$queryRaw(
          Sql.sql`SELECT id FROM bot_package_components WHERE id=${component.id} FOR UPDATE`,
        );
        if (component.status === "activated") {
          if (component.activationBinding !== binding)
            throw new ORPCError("CONFLICT", {
              message: "This skill changed. Refresh the package status.",
            });
        } else {
          if (component.revision !== input.expectedRevision || !component.content)
            throw new ORPCError("CONFLICT", {
              message: "This skill changed. Refresh the package status.",
            });
          // The shared skill service opens its own transaction, so the
          // creation is inlined here to stay atomic with the component row.
          const resolved = resolveSkillContent(
            input.name
              ? { prior: { content: component.content }, name: input.name }
              : { content: component.content },
          );
          if (
            BUILTIN_AGENT_SKILLS.some(
              (skill) => skill.name.toLowerCase() === resolved.name.toLowerCase(),
            )
          ) {
            throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
          }
          let skill: { id: string; name: string; description: string };
          try {
            await assertNameFreeWhereAvailable(
              tx,
              "skill",
              context.actor,
              resolved.name,
              userAddedAvailability(context.actor),
            );
            skill = await tx.agentSkill.create({
              data: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                name: resolved.name,
                description: resolved.description,
                content: resolved.content,
                source: "user",
                allSpaces: true,
              },
            });
          } catch (error) {
            if (isUniqueViolation(error))
              throw new ORPCError("CONFLICT", {
                message: "A skill with that name already exists.",
              });
            throw error;
          }
          await tx.botPackageComponent.update({
            where: { id: component.id },
            data: {
              name: skill.name,
              description: skill.description,
              content: null,
              status: "activated",
              targetSkillId: skill.id,
              activationBinding: binding,
              revision: { increment: 1 },
            },
          });
          await tx.botPackageImport.update({
            where: { id: component.importId },
            data: { revision: { increment: 1 } },
          });
        }
        return tx.botPackageImport.findUniqueOrThrow({
          where: { id: component.importId },
          include: includeChildren,
        });
      });
      return receipt(context.actor, row);
    },
    async export(context: Context, input: BotPackageExportInput) {
      await scope(context);
      const snapshot = await transact(context, async (tx) => {
        const bot = await tx.bot.findFirst({
          where: { ...own(context.actor), id: input.botId, archivedAt: null },
        });
        if (!bot) throw new ORPCError("NOT_FOUND");
        const components = await tx.botPackageComponent.findMany({
          where: { botId: bot.id, import: own(context.actor) },
          orderBy: { key: "asc" },
          take: 231,
        });
        if (components.length > 230)
          throw new ORPCError("BAD_REQUEST", {
            message: "The Bot has too many package components to export.",
          });
        const skillIds = [...new Set(input.skillIds)];
        const skills = skillIds.length
          ? await tx.agentSkill.findMany({
              where: {
                ...own(context.actor),
                ...activePluginSkillWhere,
                source: { in: ["user", "plugin"] },
                id: { in: skillIds },
              },
              orderBy: { id: "asc" },
            })
          : [];
        const linkedIds = components.flatMap((component) =>
          component.targetSkillId ? [component.targetSkillId] : [],
        );
        const availableTargets = linkedIds.length
          ? await tx.agentSkill.findMany({
              where: {
                ...own(context.actor),
                ...activePluginSkillWhere,
                source: { in: ["user", "plugin"] },
                id: { in: linkedIds },
              },
              select: { id: true },
            })
          : [];
        if (input.skillIds.some((id) => !skills.some((skill) => skill.id === id)))
          throw new ORPCError("NOT_FOUND", { message: "A selected skill is unavailable." });
        const routines = await tx.routine.findMany({
          where: { ...own(context.actor), botId: bot.id },
          orderBy: { id: "asc" },
          take: 51,
        });
        const memory = input.includeMemory
          ? await tx.memoryDocument.findMany({
              where: { ...own(context.actor), botId: bot.id, scope: "bot" },
              select: { path: true, content: true },
              orderBy: { path: "asc" },
              take: 101,
            })
          : [];
        const assignments = await tx.botMcpServer.findMany({
          where: { ...own(context.actor), botId: bot.id },
          select: { server: { select: { name: true } } },
          take: 31,
        });
        if (routines.length > 50 || memory.length > 100 || assignments.length > 30)
          throw new ORPCError("BAD_REQUEST", {
            message: "The Bot exceeds the package collection limits.",
          });
        return { bot, components, skills, routines, memory, assignments, availableTargets };
      });
      const { bot, components, skills, routines, memory, assignments, availableTargets } = snapshot;
      const leftOut: BotPackageLeftOut[] = [
        note(
          "profile.runtime",
          "Model, computer, fleet, conversation, file and permission bindings are not exported.",
        ),
      ];
      const portableRoutines = routines.flatMap((routine, index) => {
        if (!routine.crons.length || routine.crons.some(isOneShotRoutineCron)) {
          leftOut.push(
            note(`routines[${index}]`, "Event or one-shot schedules need manual setup.", "routine"),
          );
          return [];
        }
        // This Routine model has no native event-trigger relation; a change
        // trigger, webhook, GitHub, message, or email trigger is external.
        if (
          routine.watch != null ||
          routine.webhookEnabled ||
          routine.githubEnabled ||
          routine.messageProvider ||
          routine.emailSenders != null
        )
          leftOut.push(
            note(
              `routines[${index}].triggers`,
              "External triggers and their authorization are not exported.",
              "routine",
            ),
          );
        return [
          {
            name: routine.name,
            prompt: routine.prompt,
            crons: routine.crons,
            timezone: routine.timezone,
          },
        ];
      });
      for (const component of components)
        if (
          component.targetSkillId &&
          !skills.some((skill) => skill.id === component.targetSkillId)
        )
          leftOut.push(
            note(
              component.key,
              availableTargets.some((skill) => skill.id === component.targetSkillId)
                ? "This shared skill was not selected for export."
                : "The activated shared skill was removed and is not restored.",
              "skill",
            ),
          );
      const connections = [
        ...components
          .filter((component) => component.kind === "connection")
          .map((component) => ({ name: component.name, note: component.description })),
        ...assignments.map((assignment) => ({
          name: assignment.server.name,
          note: "Configure and authorize this connection separately.",
        })),
      ];
      const uniqueConnections = connections.filter(
        (connection, index) =>
          connections.findIndex(
            (other) => other.name === connection.name && other.note === connection.note,
          ) === index,
      );
      if (assignments.length)
        leftOut.push(
          note(
            "connections.bindings",
            "Connection identifiers, endpoints, accounts and credential fields are not exported.",
            "connection",
          ),
        );
      if (!input.includeMemory)
        leftOut.push(note("memory", "Memory notes were not selected.", "memory"));
      let safe: ReturnType<typeof prepareBotPackageDocument>;
      try {
        safe = prepareBotPackageDocument({
          format: BOT_PACKAGE_FORMAT,
          profile: {
            name: bot.name,
            // This Bot model has no title column.
            title: "",
            description: bot.description,
            instructions: bot.instructions,
            color: bot.color,
          },
          skills: [
            ...components
              .filter((component) => component.kind === "skill" && component.status === "pending")
              .map((component) => ({
                name: component.name,
                description: component.description,
                content: component.content,
              })),
            ...skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              content: skill.content,
            })),
          ],
          routines: portableRoutines,
          connections: uniqueConnections,
          memory,
        });
      } catch (error) {
        return packageError(error);
      }
      leftOut.push(...safe.leftOut);
      const json = safe.json;
      const filename = `${
        safe.document.profile.name
          .replace(/[^a-z0-9_-]/gi, "-")
          .replace(/-+/g, "-")
          .slice(0, 60) || "bot"
      }.coginebot.json`;
      return { document: safe.document, json, filename, leftOut };
    },
  };
}
