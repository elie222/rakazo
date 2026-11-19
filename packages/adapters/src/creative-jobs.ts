import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { attachmentExtensionForMimeType, messageBlockForArtifact } from "@rakazo/core";
import type { ExternalEffect, PrismaClient, ThreadEvents } from "@rakazo/db";
import { Prisma, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import type { UserAccessCredential } from "./configured-apps.js";
import type { CreativeJob, CreativeToolInput } from "./creative-contracts.js";
import { creativeInputSchema, creativeToolInputSchema } from "./creative-contracts.js";
import type { CreativeProvider } from "./creative-provider.js";
import { CreativeServiceError } from "./creative-provider.js";
import {
  creativeSubmission,
  planCreativeReferences,
  referencePlanSchema,
  referenceTransferSchema,
  uploadCreativeReferences,
} from "./creative-references.js";
import { persistMessageInTransaction } from "./runs/assembly/run-messages.js";
import { attachWorkspaceFileToThread } from "./storage/thread-artifacts.js";

const KIND = "creative_job";
// Older API replicas cannot consume a reference intent as a text-only creation.
const REFERENCE_KIND = "creative_reference_job";
const MEDIA_REFERENCE_KIND = "creative_media_reference_job";
const KINDS = [KIND, REFERENCE_KIND, MEDIA_REFERENCE_KIND];
const intentSchema = z.object({
  connectionId: z.string(),
  ref: z.string(),
  userId: z.string(),
  threadId: z.string(),
  botId: z.string(),
  input: creativeToolInputSchema,
  /** Present when the approved tool input omitted the resolved preset in input. */
  toolInput: creativeToolInputSchema.optional(),
  referencePlan: referencePlanSchema.optional(),
});
const stateSchema = z.object({
  leaseToken: z.string().optional(),
  dispatched: z.boolean().default(false),
  accepted: z.boolean().default(false),
  remoteStatus: z.enum(["queued", "running", "succeeded", "failed", "unknown"]).default("queued"),
  errorCode: z.string().optional(),
  retries: z.number().int().default(0),
  delivered: z.record(z.string(), z.string()).default({}),
  referenceTransfers: z.record(z.string(), referenceTransferSchema).default({}),
  submission: creativeInputSchema.optional(),
});
type Intent = z.infer<typeof intentSchema>;

function comparableIntent({ toolInput, input, ...identity }: Intent) {
  const { preset, ...original } = toolInput ?? input;
  return {
    ...identity,
    input: {
      ...original,
      ...(preset === undefined ? {} : { preset }),
      parameters: original.parameters ?? {},
      referenceArtifactIds: original.referenceArtifactIds ?? [],
    },
  };
}
export interface CreativeJobsDeps {
  prisma: PrismaClient;
  artifacts: ArtifactStore;
  events: ThreadEvents;
  maxUploadSizeBytes?: number;
}
export interface CreativeAccess {
  provider: CreativeProvider;
  authorizationBlock(): MessageBlock;
  /** Recheck the original initiator, membership, exact connection and binding for every remote read. */
  authorize(
    context: AdapterContext,
    connectionId: string,
    ref: string,
  ): Promise<UserAccessCredential>;
}

/** Durable per-operation intent and fenced delivery using the existing effect store. */
export class CreativeJobs {
  constructor(
    private readonly deps: CreativeJobsDeps,
    private readonly access: CreativeAccess,
  ) {}

  private started = false;
  private readonly shutdown = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly scans = new Set<Promise<void>>();

  /** API-side app hosts recover persisted operations; each operation retains its own database lease. */
  start() {
    if (this.started || this.shutdown.signal.aborted) return;
    this.started = true;
    const restore = () => {
      const scan = this.reconcile().catch(() => getLogger().warn("Creation recovery unavailable"));
      this.scans.add(scan);
      void scan.then(() => this.scans.delete(scan));
    };
    this.timer = setInterval(restore, 30_000);
    this.timer.unref();
    restore();
  }
  async stop() {
    this.shutdown.abort();
    clearInterval(this.timer);
    for (const timer of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
    await Promise.allSettled(this.scans);
    await Promise.allSettled(this.active.values());
  }
  private async enqueue(id: string, delay = 30_000) {
    if (!this.started || this.shutdown.signal.aborted) return;
    clearTimeout(this.scheduled.get(id));
    const timer = setTimeout(() => {
      this.scheduled.delete(id);
      void this.poll(id).catch(() => getLogger().warn("Creation check unavailable"));
    }, delay);
    timer.unref();
    this.scheduled.set(id, timer);
  }
  async submit(
    context: AdapterContext,
    executionId: string,
    connectionId: string,
    ref: string,
    submitted: CreativeToolInput,
  ) {
    let input = submitted;
    if (!context.runId) throw new CreativeServiceError("forbidden", 403);
    const run = await this.deps.prisma.run.findFirst({
      where: {
        id: context.runId,
        spaceId: context.spaceId,
        userId: context.userId,
        status: "running",
        // Only a directly attributable request may spend this person's balance.
        trigger: { in: ["user", "follow_up"] },
        sourceMessage: { role: "user" },
      },
    });
    if (!run) throw new CreativeServiceError("forbidden", 403);
    const key = `creative:${run.id}:${executionId}`;
    // Resolve every new selection against the directory; recovery reuses the saved choice.
    const existing = await this.deps.prisma.externalEffect.findUnique({
      where: { idempotencyKey: key },
    });
    const persisted = existing ? intentSchema.parse(existing.request) : undefined;
    let toolInput = persisted?.toolInput ? submitted : undefined;
    if (persisted?.toolInput && input.preset === undefined)
      input = { ...input, preset: persisted.input.preset };
    let referencePlan = persisted?.referencePlan;
    if (!existing) {
      const identity = await this.access.authorize(context, connectionId, ref);
      const catalog = await this.access.provider.capabilities(identity, context.signal);
      const model = catalog.models.find(
        (model) => model.id === input.model && model.kind === input.kind,
      );
      const presetId = input.preset ?? model?.defaultPreset;
      if (!model?.presets.some((preset) => preset.id === presetId))
        throw new CreativeServiceError("selection_unavailable", 422);
      // Freeze the chosen default once, so later directory changes cannot alter a replay.
      input = { ...input, preset: presetId };
      if (submitted.preset === undefined) toolInput = submitted;
      const properties = model.parameters?.properties;
      if (
        input.parameters &&
        Object.keys(input.parameters).length &&
        (catalog.submission?.presetOnly !== false ||
          !properties ||
          typeof properties !== "object" ||
          Array.isArray(properties) ||
          Object.keys(input.parameters).some((key) => !Object.hasOwn(properties, key)))
      )
        throw new CreativeServiceError("invalid_parameters", 422);
      if (input.referenceArtifactIds?.length)
        referencePlan = await planCreativeReferences(
          this.deps,
          context,
          run.threadId,
          input,
          catalog,
        );
      // The service validates types, ranges and combinations using its own authoritative rules.
    }
    const request: Intent = {
      connectionId,
      ref,
      userId: run.userId,
      threadId: run.threadId,
      botId: run.botId,
      input,
      ...(toolInput ? { toolInput } : {}),
      ...(referencePlan ? { referencePlan } : {}),
    };
    const effect = await this.deps.prisma.externalEffect
      .upsert({
        where: { idempotencyKey: key },
        update: {},
        create: {
          id: randomUUID(),
          spaceId: run.spaceId,
          runId: run.id,
          kind: input.referenceArtifactIds?.length ? MEDIA_REFERENCE_KIND : KIND,
          idempotencyKey: key,
          status: "creative_pending",
          request,
          result: { dispatched: false, retries: 0, delivered: {} },
        },
      })
      .catch(async (error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const existing = await this.deps.prisma.externalEffect.findUnique({
            where: { idempotencyKey: key },
          });
          if (existing) return existing;
        }
        throw error;
      });
    const saved = intentSchema.parse(effect.request);
    if (!isDeepStrictEqual(comparableIntent(saved), comparableIntent(request)))
      throw new CreativeServiceError("operation_conflict", 409);
    // Schedule before network I/O; the reconciler also repairs a crash between these writes.
    await this.enqueue(effect.id);
    await this.poll(effect.id);
    const current = await this.deps.prisma.externalEffect.findUniqueOrThrow({
      where: { id: effect.id },
    });
    return this.publicResult(current);
  }
  async result(context: AdapterContext, operationId: string, connectionRef: string) {
    const effect = await this.deps.prisma.externalEffect.findFirst({
      where: {
        id: operationId,
        kind: { in: KINDS },
        spaceId: context.spaceId,
        run: { userId: context.userId },
      },
    });
    if (!effect) throw new CreativeServiceError("not_found", 404);
    const intent = intentSchema.parse(effect.request);
    if (intent.ref !== connectionRef) throw new CreativeServiceError("not_found", 404);
    try {
      await this.access.authorize(context, intent.connectionId, intent.ref);
    } catch (error) {
      if (error instanceof CreativeServiceError && error.code === "forbidden")
        throw new CreativeServiceError("not_found", 404);
      throw error;
    }
    // Local state only: querying a result never creates a charged request.
    return this.publicResult(effect);
  }
  private publicResult(effect: ExternalEffect) {
    const state = stateSchema.parse(effect.result ?? {});
    if (state.errorCode === "not_found") throw new CreativeServiceError("not_found", 404);
    return {
      operationId: effect.id,
      status: state.remoteStatus,
      ...(state.errorCode ? { errorCode: state.errorCode } : {}),
    };
  }
  async reconcile() {
    await runAsSystem("restore creative job checks", async () => {
      const rows = await this.deps.prisma.externalEffect.findMany({
        where: {
          kind: { in: KINDS },
          status: { in: ["creative_pending", "creative_polling"] },
          updatedAt: { lt: new Date(Date.now() - 90_000) },
        },
        select: { id: true },
        take: 100,
        orderBy: { updatedAt: "asc" },
      });
      await Promise.allSettled(rows.map((row) => this.poll(row.id)));
    });
  }
  poll(operationId: string): Promise<void> {
    if (this.shutdown.signal.aborted) return Promise.resolve();
    const active = this.active.get(operationId);
    if (active) return active;
    const work = runAsSystem("check a persisted creation", () =>
      this.pollClaimed(operationId),
    ).finally(() => this.active.delete(operationId));
    this.active.set(operationId, work);
    return work;
  }
  private async pollClaimed(operationId: string) {
    const { prisma } = this.deps;
    const effect = await prisma.externalEffect.findFirst({
      where: { id: operationId, kind: { in: KINDS } },
    });
    if (!effect || !["creative_pending", "creative_polling"].includes(effect.status)) return;
    const intent = intentSchema.parse(effect.request);
    const state = stateSchema.parse(effect.result ?? {});
    state.leaseToken = randomUUID();
    const claim = await prisma.externalEffect.updateMany({
      where: {
        id: effect.id,
        updatedAt: effect.updatedAt,
        OR: [
          { status: "creative_pending" },
          { status: "creative_polling", updatedAt: { lt: new Date(Date.now() - 90_000) } },
        ],
      },
      data: { status: "creative_polling", result: state },
    });
    if (!claim.count) return;
    const fence = {
      id: effect.id,
      status: "creative_polling",
      result: { path: ["leaseToken"], equals: state.leaseToken },
    };
    const context: AdapterContext = {
      operationId,
      traceId: operationId,
      spaceId: effect.spaceId,
      userId: intent.userId,
      botId: intent.botId,
      runId: effect.runId,
      signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(60_000)]),
    };
    try {
      let identity = await this.access.authorize(context, intent.connectionId, intent.ref);
      const run = await prisma.run.findFirst({
        where: {
          id: effect.runId,
          spaceId: effect.spaceId,
          userId: intent.userId,
          botId: intent.botId,
          threadId: intent.threadId,
          status: { not: "cancelled" },
        },
      });
      const thread = await prisma.thread.findFirst({
        where: { id: intent.threadId, spaceId: effect.spaceId },
      });
      if (!run || !thread) throw new CreativeServiceError("forbidden", 403);
      let snapshot: CreativeJob;
      if (state.dispatched && intent.referencePlan && !state.submission)
        throw new CreativeServiceError("invalid_response");
      if (!state.dispatched) {
        if (intent.input.referenceArtifactIds?.length && !intent.referencePlan)
          throw new CreativeServiceError("invalid_response");
        if (!state.submission) {
          const references = intent.referencePlan
            ? await uploadCreativeReferences({
                deps: this.deps,
                context,
                threadId: intent.threadId,
                plan: intent.referencePlan,
                identity: () => this.access.authorize(context, intent.connectionId, intent.ref),
                provider: this.access.provider,
                transfers: state.referenceTransfers,
                save: async () =>
                  (
                    await prisma.externalEffect.updateMany({
                      where: fence,
                      data: { result: state },
                    })
                  ).count > 0,
              })
            : undefined;
          if (references === null) return;
          state.submission = creativeSubmission(intent.input, references);
          if (
            !(await prisma.externalEffect.updateMany({ where: fence, data: { result: state } }))
              .count
          )
            return;
        }
        if (intent.referencePlan) {
          identity = await this.access.authorize(context, intent.connectionId, intent.ref);
          if (
            !(await prisma.run.findFirst({
              where: {
                id: effect.runId,
                userId: intent.userId,
                spaceId: effect.spaceId,
                status: { not: "cancelled" },
              },
            }))
          )
            throw new CreativeServiceError("forbidden", 403);
        }
        // Persist dispatch before PUT. On any uncertainty, the next attempt starts with GET.
        const marked = await prisma.externalEffect.updateMany({
          where: fence,
          data: { result: { ...state, dispatched: true } },
        });
        if (!marked.count) return;
        state.dispatched = true;
        snapshot = await this.access.provider.submit(
          identity,
          operationId,
          state.submission,
          context.signal,
        );
      } else {
        try {
          snapshot = await this.access.provider.job(identity, operationId, context.signal);
        } catch (error) {
          // Only a definitive not-found permits bounded replay of the persisted request and ID.
          if (
            !(error instanceof CreativeServiceError) ||
            error.code !== "not_found" ||
            state.accepted ||
            state.retries >= 2
          )
            throw error;
          state.retries++;
          const marked = await prisma.externalEffect.updateMany({
            where: fence,
            data: { result: state },
          });
          if (!marked.count) return;
          const current = await this.access.authorize(context, intent.connectionId, intent.ref);
          snapshot = await this.access.provider.submit(
            current,
            operationId,
            state.submission ?? creativeSubmission(intent.input),
            context.signal,
          );
        }
      }
      state.accepted = true;
      state.remoteStatus = snapshot.status;
      state.errorCode = snapshot.errorCode;
      if (snapshot.status === "queued" || snapshot.status === "running") {
        const updated = await prisma.externalEffect.updateMany({
          where: fence,
          data: { status: "creative_pending", result: state },
        });
        if (updated.count) await this.enqueue(operationId);
        return;
      }
      if (snapshot.status === "failed") {
        const saved = await prisma.externalEffect.updateMany({
          where: fence,
          data: { result: state },
        });
        if (!saved.count) return;
        await this.publish(
          effect,
          intent,
          fence,
          "failure",
          snapshot.errorCode === "authorization_required"
            ? [this.access.authorizationBlock()]
            : [{ kind: "text", text: "Creation failed." }],
          "creative_failed",
        );
        return;
      }
      if (snapshot.status === "succeeded" && !snapshot.outputs.length) {
        if (
          !(await this.publish(effect, intent, fence, "empty", [
            { kind: "text", text: "Creation completed, but the file is unavailable." },
          ]))
        )
          return;
      }
      for (const output of snapshot.outputs) {
        context.signal.throwIfAborted();
        // Reuse the attachment key so opaque output IDs never become object property names.
        const outputKey = createHash("sha256").update(output.id).digest("hex").slice(0, 24);
        if (Object.hasOwn(state.delivered, outputKey)) continue;
        const current = await this.access.authorize(context, intent.connectionId, intent.ref);
        const artifact = await prisma.artifact.findFirst({
          where: {
            spaceId: effect.spaceId,
            userId: intent.userId,
            runId: effect.runId,
            clientNonce: `creative:${operationId}:${outputKey}`,
          },
        });
        if (artifact) {
          if (
            !(await this.publish(effect, intent, fence, output.id, [
              messageBlockForArtifact(artifact),
            ]))
          )
            return;
          state.delivered[outputKey] = artifact.id;
          continue;
        }
        const extension = attachmentExtensionForMimeType(output.mimeType);
        const expectedKind = intent.input.kind === "music" ? "audio/" : `${intent.input.kind}/`;
        if (!extension || !output.mimeType.startsWith(expectedKind))
          throw new CreativeServiceError("invalid_response");
        const response = await this.access.provider
          .output(current, operationId, output.id, context.signal)
          .catch((error: unknown) => {
            if (error instanceof CreativeServiceError && error.code === "not_found") return null;
            throw error;
          });
        if (!response) {
          state.delivered[outputKey] = "unavailable";
          continue;
        }
        if (response.headers.get("content-type")?.split(";")[0]?.trim() !== output.mimeType) {
          await response.body?.cancel();
          throw new CreativeServiceError("invalid_response");
        }
        const limit = this.deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES;
        const bytes = await boundedOutput(response, limit);
        await this.access.authorize(context, intent.connectionId, intent.ref);
        if (!bytes) {
          const committed = await this.publish(effect, intent, fence, output.id, [
            {
              kind: "text",
              text: "Creation completed, but the file exceeds the attachment limit.",
            },
          ]);
          if (!committed) return;
          state.delivered[outputKey] = "oversized";
        } else {
          // Checkpoint each output atomically with the attachment; a crash can publish it later.
          const attached = await attachWorkspaceFileToThread(this.deps, {
            spaceId: effect.spaceId,
            userId: intent.userId,
            botId: intent.botId,
            runId: effect.runId,
            groupId: thread.groupId ?? undefined,
            filePath: `creation-${operationId}-${outputKey}${extension}`,
            name: Array.from(output.name, (character) =>
              character.charCodeAt(0) < 32 || character === "/" || character === "\\"
                ? "_"
                : character,
            ).join(""),
            bytes,
            operationId,
            onAttached: async (tx, row) => {
              const owned = await tx.externalEffect.updateMany({
                where: fence,
                data: { result: state },
              });
              if (!owned.count) throw new CreativeServiceError("unavailable");
              await tx.artifact.update({
                where: { id: row.id },
                data: { clientNonce: `creative:${operationId}:${outputKey}` },
              });
            },
          });
          if (!(await this.publish(effect, intent, fence, output.id, [attached.block]))) return;
          state.delivered[outputKey] = attached.artifactId;
        }
      }
      await prisma.externalEffect.updateMany({
        where: fence,
        data: {
          status: snapshot.status === "unknown" ? "creative_pending" : "creative_succeeded",
          result: state,
        },
      });
      if (snapshot.status === "unknown") await this.enqueue(operationId);
    } catch (error) {
      if (error instanceof CreativeServiceError) state.errorCode = error.code;
      const terminal =
        error instanceof CreativeServiceError &&
        [
          "forbidden",
          "authorization_required",
          "operation_conflict",
          "invalid_parameters",
          "account_changed",
          "invalid_response",
          "selection_unavailable",
          "not_found",
          "reference_image_too_large",
          "invalid_reference_image",
          "unsupported_media",
          "reference_media_too_large",
          "invalid_reference_media",
        ].includes(error.code);
      if (terminal) {
        state.remoteStatus = "failed";
        state.errorCode = error.code;
      }
      if (terminal && error.code === "authorization_required") {
        await this.publish(effect, intent, fence, "authorization", [
          this.access.authorizationBlock(),
        ]);
      }
      const updated = await prisma.externalEffect.updateMany({
        where: fence,
        data: { status: terminal ? "creative_failed" : "creative_pending", result: state },
      });
      if (updated.count && !terminal) await this.enqueue(operationId);
      if (terminal) throw new CreativeServiceError(error.code, error.status);
    }
  }
  private async publish(
    effect: ExternalEffect,
    intent: Intent,
    fence: { id: string; status: string; result: { path: string[]; equals: string } },
    outputId: string,
    blocks: MessageBlock[],
    status?: string,
  ) {
    await this.access.authorize(
      {
        userId: intent.userId,
        spaceId: effect.spaceId,
        runId: effect.runId,
        botId: intent.botId,
        operationId: effect.id,
        traceId: effect.id,
        signal: AbortSignal.timeout(10_000),
      },
      intent.connectionId,
      intent.ref,
    );
    const thread = await this.deps.prisma.thread.findFirst({
      where: { id: intent.threadId, spaceId: effect.spaceId, userId: intent.userId },
    });
    if (!thread) throw new CreativeServiceError("forbidden", 403);
    const nonce = `creative:${effect.id}:${outputId}`;
    const committed = await this.deps.prisma.$transaction(async (tx) => {
      const owned = await tx.externalEffect.updateMany({
        where: fence,
        data: { ...(status ? { status } : {}), updatedAt: new Date() },
      });
      if (!owned.count) return null;
      const existing = await tx.message.findFirst({
        where: { threadId: intent.threadId, clientNonce: nonce },
      });
      if (existing) return { eventSeq: 0, firstResponseRunId: undefined };
      return persistMessageInTransaction(
        tx,
        {
          id: effect.runId,
          spaceId: effect.spaceId,
          threadId: intent.threadId,
          botId: intent.botId,
        },
        "bot",
        blocks,
        true,
        nonce,
      );
    });
    if (!committed) return false;
    if (committed.eventSeq)
      await this.deps.events
        .notify(intent.threadId, committed.eventSeq, committed.firstResponseRunId)
        .catch(() => undefined);
    return true;
  }
}

async function boundedOutput(response: Response, maximum: number): Promise<Uint8Array | null> {
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) throw new CreativeServiceError("invalid_response");
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!length) throw new CreativeServiceError("invalid_response");
  return Buffer.concat(chunks, length);
}
