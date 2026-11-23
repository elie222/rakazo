import { ORPCError } from "@orpc/server";
import { MemoryRevisionConflictError } from "@rakazo/adapter-kit";
import {
  buildAgentMemoryPrompt,
  isScratchpadStatus,
  listMemoryDreams,
  listScratchpadItems,
  mapScratchpadItem,
  memoryDocumentError,
  memoryProviderDescriptors,
  readAgentMemory,
  startManualMemoryDream,
  undoMemoryDream,
} from "@rakazo/adapters";
import { isDeletableMemoryDocument } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { findSpaceMemoryConfig, IsolationError, isOwnerRole, requireSpaceOwner } from "@rakazo/db";
import {
  disconnectMemoryProvider,
  persistMemoryProviderConfig,
  serializeSpaceMemoryConfig,
  updateMemoryProviderConfig,
  updateMemoryProviderDefaultScope,
} from "../integrations/memory-provider-config.js";
import type { RouterContext } from "./context.js";

export function memoryRoutes(ctx: RouterContext) {
  const { deps, repos, taughtSkills, agentSkills, authed } = ctx;
  return {
    memory: {
      list: authed.memory.list.handler(async ({ context, input }) => {
        const docs = await deps.prisma.memoryDocument.findMany({
          where: {
            spaceId: context.actor.spaceId,
            ...(input.botId ? { botId: input.botId } : {}),
            ...(input.scope ? { scope: input.scope } : {}),
          },
        });
        return docs.map((doc) => ({
          id: doc.id,
          scope: doc.scope as "bot" | "user",
          botId: doc.botId,
          path: doc.path,
          content: doc.content,
          description: doc.description,
          revision: doc.revision,
          updatedAt: doc.updatedAt.toISOString(),
        }));
      }),
      budget: authed.memory.budget.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        // Read through the store a run uses, so the numbers match what the bot receives.
        const documents = await readAgentMemory(
          deps.memory,
          input.botId,
          {
            operationId: "mem",
            traceId: "mem",
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            botId: input.botId,
            signal: context.signal ?? new AbortController().signal,
          },
          { includeBot: bot.useOwnMemory, includeUser: bot.useSharedMemory },
        );
        return buildAgentMemoryPrompt(documents).plan;
      }),
      dreams: authed.memory.dreams.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return listMemoryDreams(deps.prisma, {
          spaceId: context.actor.spaceId,
          botId: input.botId,
          limit: input.limit,
          cursor: input.cursor,
        });
      }),
      dreamRetention: authed.memory.dreamRetention.handler(async ({ context }) => {
        const [space, membership] = await Promise.all([
          deps.prisma.space.findUnique({
            where: { id: context.actor.spaceId },
            select: { dreamRetention: true },
          }),
          deps.prisma.spaceMember.findUnique({
            where: {
              spaceId_userId: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            },
            select: { role: true },
          }),
        ]);
        return {
          dreamRetention: space?.dreamRetention ?? null,
          canManage: isOwnerRole(membership?.role ?? ""),
        };
      }),
      setDreamRetention: authed.memory.setDreamRetention.handler(async ({ context, input }) => {
        await requireSpaceOwner(deps.prisma, context.actor);
        await deps.prisma.space.update({
          where: { id: context.actor.spaceId },
          data: { dreamRetention: input.dreamRetention },
        });
        return { dreamRetention: input.dreamRetention };
      }),
      dreamNow: authed.memory.dreamNow.handler(async ({ context, input }) =>
        startManualMemoryDream(
          { prisma: deps.prisma, jobs: deps.jobs },
          { spaceId: context.actor.spaceId, botId: input.botId },
        ),
      ),
      undoDream: authed.memory.undoDream.handler(async ({ context, input }) =>
        undoMemoryDream(deps.prisma, {
          spaceId: context.actor.spaceId,
          dreamId: input.dreamId,
        }),
      ),
      revisions: authed.memory.revisions.handler(async ({ context, input }) => {
        const doc = await deps.prisma.memoryDocument.findFirst({
          where: { id: input.documentId, spaceId: context.actor.spaceId },
          select: { id: true },
        });
        if (!doc) throw new IsolationError();
        return deps.memory.listRevisions(
          { documentId: doc.id, limit: input.limit, cursor: input.cursor },
          memoryCallContext(context.actor),
        );
      }),
      revision: authed.memory.revision.handler(async ({ context, input }) => {
        const doc = await deps.prisma.memoryDocument.findFirst({
          where: { id: input.documentId, spaceId: context.actor.spaceId },
          select: { id: true },
        });
        if (!doc) throw new IsolationError();
        const revision = await deps.memory.readRevision(
          { documentId: doc.id, revisionId: input.revisionId },
          memoryCallContext(context.actor),
        );
        if (!revision) throw new IsolationError();
        return revision;
      }),
      restore: authed.memory.restore.handler(async ({ context, input }) => {
        const doc = await deps.prisma.memoryDocument.findFirst({
          where: { id: input.documentId, spaceId: context.actor.spaceId },
        });
        if (!doc) throw new IsolationError();
        const revision = await deps.memory.readRevision(
          { documentId: doc.id, revisionId: input.revisionId },
          memoryCallContext(context.actor),
        );
        if (!revision) throw new IsolationError();
        const scope = doc.scope === "user" ? "user" : "bot";
        const invalid = memoryDocumentError(scope, doc.path, revision.content);
        if (invalid) throw new ClientError("BAD_REQUEST", invalid);
        const updated = await deps.memory
          .commit(
            {
              scope,
              botId: doc.botId ?? undefined,
              path: doc.path,
              content: revision.content,
              expectedRevision: input.expectedRevision,
              sourceKind: "undo",
            },
            memoryCallContext(context.actor),
          )
          .catch((error: unknown) => {
            if (error instanceof MemoryRevisionConflictError) {
              throw new ClientError("CONFLICT", error.message);
            }
            throw error;
          });
        return {
          id: updated.id,
          scope,
          botId: doc.botId,
          path: updated.path,
          content: updated.content,
          description: doc.description,
          revision: updated.revision,
          updatedAt: new Date().toISOString(),
        };
      }),
      update: authed.memory.update.handler(async ({ context, input }) => {
        const doc = await deps.prisma.memoryDocument.findFirst({
          where: {
            id: input.documentId,
            spaceId: context.actor.spaceId,
          },
        });
        if (!doc) throw new IsolationError();
        const invalid = memoryDocumentError(
          doc.scope === "user" ? "user" : "bot",
          doc.path,
          input.content,
        );
        if (invalid) throw new ClientError("BAD_REQUEST", invalid);
        const updated = await deps.memory
          .commit(
            {
              scope: doc.scope as "bot" | "user",
              botId: doc.botId ?? undefined,
              path: doc.path,
              content: input.content,
              description: input.description,
              expectedRevision: input.expectedRevision,
              sourceKind: "user",
            },
            {
              operationId: "mem",
              traceId: "mem",
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              signal: new AbortController().signal,
            },
          )
          .catch((error: unknown) => {
            if (error instanceof MemoryRevisionConflictError) {
              throw new ClientError("CONFLICT", error.message);
            }
            throw error;
          });
        return {
          id: updated.id,
          scope: doc.scope as "bot" | "user",
          botId: doc.botId,
          path: updated.path,
          content: updated.content,
          description: input.description === undefined ? doc.description : input.description,
          revision: updated.revision,
          updatedAt: new Date().toISOString(),
        };
      }),
      remove: authed.memory.remove.handler(async ({ context, input }) => {
        const doc = await deps.prisma.memoryDocument.findFirst({
          where: {
            id: input.documentId,
            spaceId: context.actor.spaceId,
          },
        });
        if (!doc) throw new IsolationError();
        if (!isDeletableMemoryDocument(doc.path)) {
          throw new ORPCError("BAD_REQUEST", {
            message: `${doc.path} cannot be deleted; edit its content instead.`,
          });
        }
        await deps.memory.remove(
          {
            id: doc.id,
            scope: doc.scope as "bot" | "user",
            botId: doc.botId ?? undefined,
            path: doc.path,
          },
          {
            operationId: "mem",
            traceId: "mem",
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            signal: new AbortController().signal,
          },
        );
        return { ok: true as const };
      }),
      exportMarkdown: authed.memory.exportMarkdown.handler(async ({ context, input }) => {
        const docs = await deps.prisma.memoryDocument.findMany({
          where: {
            spaceId: context.actor.spaceId,
            ...(input.botId ? { botId: input.botId } : {}),
          },
        });
        return docs.map((d) => `# ${d.path}\n\n${d.content}`).join("\n\n");
      }),
      providerConfig: authed.memory.providerConfig.handler(async ({ context }) => {
        const config = await findSpaceMemoryConfig(deps.prisma, context.actor.spaceId);
        return config ? serializeSpaceMemoryConfig(config) : null;
      }),
      providers: authed.memory.providers.handler(() => memoryProviderDescriptors()),
      connectProvider: authed.memory.connectProvider.handler(async ({ context, input }) =>
        persistMemoryProviderConfig(deps, context.actor, input),
      ),
      updateProvider: authed.memory.updateProvider.handler(async ({ context, input }) =>
        updateMemoryProviderConfig(deps, context.actor, input),
      ),
      setDefaultScope: authed.memory.setDefaultScope.handler(async ({ context, input }) =>
        updateMemoryProviderDefaultScope(deps, context.actor, input.defaultMemoryScope),
      ),
      disconnectProvider: authed.memory.disconnectProvider.handler(async ({ context }) =>
        disconnectMemoryProvider(deps, context.actor),
      ),
    },
    scratchpad: {
      list: authed.scratchpad.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return listScratchpadItems(
          { prisma: deps.prisma },
          {
            spaceId: context.actor.spaceId,
            botId: input.botId,
            status: input.status,
            includeDone: input.includeDone ?? false,
          },
        );
      }),
      create: authed.scratchpad.create.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const row = await deps.prisma.scratchpadItem.create({
          data: {
            spaceId: context.actor.spaceId,
            botId: input.botId,
            userId: context.actor.userId,
            title: input.title.trim(),
            status: input.status,
            notes: input.notes.trim(),
          },
        });
        return mapScratchpadItem(row);
      }),
      update: authed.scratchpad.update.handler(async ({ context, input }) => {
        const existing = await deps.prisma.scratchpadItem.findFirst({
          where: {
            id: input.itemId,
            spaceId: context.actor.spaceId,
          },
        });
        if (!existing) throw new IsolationError();
        if (input.status !== undefined && !isScratchpadStatus(input.status)) {
          throw new ORPCError("BAD_REQUEST", { message: "Invalid scratchpad status." });
        }
        const row = await deps.prisma.scratchpadItem.update({
          where: { id: existing.id },
          data: {
            ...(input.title !== undefined ? { title: input.title.trim() } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.notes !== undefined ? { notes: input.notes.trim() } : {}),
          },
        });
        return mapScratchpadItem(row);
      }),
      remove: authed.scratchpad.remove.handler(async ({ context, input }) => {
        const existing = await deps.prisma.scratchpadItem.findFirst({
          where: {
            id: input.itemId,
            spaceId: context.actor.spaceId,
          },
        });
        if (!existing) throw new IsolationError();
        await deps.prisma.scratchpadItem.delete({ where: { id: existing.id } });
        return { ok: true as const };
      }),
    },
    skills: {
      list: authed.skills.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return taughtSkills.list(context.actor, input.botId);
      }),
      get: authed.skills.get.handler(async ({ context, input }) =>
        taughtSkills.get(context.actor, input.skillId),
      ),
      start: authed.skills.start.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return taughtSkills.start(context.actor, input.botId, input.goal);
      }),
      appendEvent: authed.skills.appendEvent.handler(async ({ context, input }) =>
        taughtSkills.appendEvent(context.actor, input.skillId, input.event),
      ),
      snapshot: authed.skills.snapshot.handler(async ({ context, input }) =>
        taughtSkills.snapshot(context.actor, input.skillId),
      ),
      stop: authed.skills.stop.handler(async ({ context, input }) =>
        taughtSkills.stop(context.actor, input.skillId),
      ),
      updateDraft: authed.skills.updateDraft.handler(async ({ context, input }) =>
        taughtSkills.updateDraft(context.actor, input.skillId, {
          name: input.name,
          playbook: input.playbook,
        }),
      ),
      save: authed.skills.save.handler(async ({ context, input }) =>
        taughtSkills.save(context.actor, input.skillId, input.name),
      ),
      testRun: authed.skills.testRun.handler(async ({ context, input }) =>
        taughtSkills.testRun(context.actor, input.skillId, input.prompt),
      ),
      remove: authed.skills.remove.handler(async ({ context, input }) =>
        taughtSkills.remove(context.actor, input.skillId),
      ),
    },
    agentSkills: {
      list: authed.agentSkills.list.handler(async ({ context }) => agentSkills.list(context.actor)),
      get: authed.agentSkills.get.handler(async ({ context, input }) =>
        agentSkills.get(context.actor, input),
      ),
      create: authed.agentSkills.create.handler(async ({ context, input }) =>
        agentSkills.create(context.actor, input),
      ),
      update: authed.agentSkills.update.handler(async ({ context, input }) =>
        agentSkills.update(context.actor, input),
      ),
      remove: authed.agentSkills.remove.handler(async ({ context, input }) =>
        agentSkills.remove(context.actor, input.skillId),
      ),
    },
  };
}

/** The adapter context every memory store call in this router uses. */
function memoryCallContext(actor: { spaceId: string; userId: string }) {
  return {
    operationId: "mem",
    traceId: "mem",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  };
}
