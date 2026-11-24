import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import {
  inferAttachmentMimeType,
  isBackgroundRunTrigger,
  messageBlockForArtifact,
} from "@rakazo/core";
import type { Artifact, Prisma } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { resolveBotWorkspacePath } from "../../computers/screens/computer-support.js";
import {
  generateMediaFromTool,
  MEDIA_JOB_KIND,
  MEDIA_UNAVAILABLE,
  VIDEO_JOB_UNAVAILABLE,
} from "../../media/media-generation-tools.js";
import type { MediaSource, ResolvedMediaSource } from "../../media/media-sources.js";
import { mediaVideoProviderForSource, readMediaJobSource } from "../../media/media-sources.js";
import { hostedMediaPrice } from "../../media/media-usage.js";
import { mediaDelivery, scheduleMediaPoll } from "../../media/media-video-poll.js";
import { attachWorkspaceFileToThread } from "../../storage/thread-artifacts.js";
import type { RunWorkspace } from "../../tools/workspace-file-tools.js";
import {
  listFilesFromTool,
  readFileFromTool,
  renderPlotFromTool,
} from "../../tools/workspace-file-tools.js";
import type { RunContext } from "../assembly/run-context.js";
import { persistMessageInTransaction, runLeaseFor } from "../assembly/run-messages.js";
import { textContentArg } from "../turn/tool-text.js";
import { readStoppedRunFile } from "./run-stopped-file.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { recordComputerAction } from "./run-tools-computer.js";

export type AttachmentBlock = Extract<MessageBlock, { kind: "image" | "file" }>;

function runWorkspace(ctx: RunContext, call: ToolCall): RunWorkspace {
  return {
    botId: ctx.bot.id,
    computerMode: ctx.computer.mode,
    computer: () => ctx.computer.get("tool", call.name),
    markDirty: () => ctx.computer.checkpoint.markDirty(),
    context: ctx.context,
    runSecrets: ctx.secrets,
  };
}

async function artifactGroupId(ctx: RunContext): Promise<string | undefined> {
  const threadId = ctx.source.conversationThreadId;
  if (!threadId || threadId === ctx.thread.id) return ctx.thread.groupId ?? undefined;
  const conversation = await ctx.deps.prisma.thread.findFirst({
    where: { id: threadId, spaceId: ctx.run.spaceId },
    select: { groupId: true },
  });
  return conversation?.groupId ?? undefined;
}

/**
 * A video checked by its job id keeps the source that made it, even if the run's has changed;
 * null when the job's saved request is unreadable, so no source is guessed for it.
 */
type SettledMediaJob = { status: "completed"; artifactId: string } | { status: "failed" };

async function savedJobSource(
  ctx: RunContext,
  jobId: unknown,
): Promise<MediaSource | { settled: SettledMediaJob } | null | undefined> {
  if (typeof jobId !== "string") return undefined;
  const { run } = ctx;
  const job = await ctx.deps.prisma.externalEffect.findFirst({
    where: {
      id: jobId,
      kind: MEDIA_JOB_KIND,
      spaceId: run.spaceId,
      run: { userId: run.userId, botId: run.botId, threadId: run.threadId },
    },
    select: { id: true, request: true, status: true, result: true },
  });
  if (!job) return undefined;
  // A settled job needs no provider, so it still answers after its connection is removed.
  const artifactId = settledArtifactId(job.result);
  if (job.status === "media_completed" && artifactId)
    return { settled: { status: "completed", artifactId } };
  if (job.status === "media_failed") return { settled: { status: "failed" } };
  const record = readMediaJobSource(job);
  if (!record) return null;
  const deps = { ...ctx.deps, mediaGeneration: ctx.providers.mediaGeneration };
  return async () => {
    const provider = await mediaVideoProviderForSource(deps, run.userId, record);
    return provider && { record, provider };
  };
}

function settledArtifactId(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("artifactId" in result)) return undefined;
  return typeof result.artifactId === "string" ? result.artifactId : undefined;
}

/** Generate an image or video, or with recoverOnly, only resume a job an earlier attempt started. */
export async function callMediaTool(ctx: RunContext, call: ToolCall, recoverOnly = false) {
  const { deps, run, thread, context } = ctx;
  const { name, args, executionId, applied } = call;
  if (
    (name !== "generate_image" && name !== "generate_video") ||
    isBackgroundRunTrigger(run.trigger) ||
    !deps.artifacts
  )
    return { error: MEDIA_UNAVAILABLE };
  // Only a well-formed video check reads its saved job; anything else gets the tool's own refusal.
  const saved =
    name === "generate_video" && args.prompt === undefined
      ? await savedJobSource(ctx, args.jobId)
      : undefined;
  if (saved === null) return { error: VIDEO_JOB_UNAVAILABLE };
  if (saved && "settled" in saved) return saved.settled;
  let source: ResolvedMediaSource | undefined;
  try {
    source = await (
      saved ?? (name === "generate_image" ? ctx.providers.media.image : ctx.providers.media.video)
    )?.();
  } catch (error) {
    if (!(error instanceof SecretStoreUnavailableError)) throw error;
    getLogger().warn("media.connection_secret_unavailable", { "run.id": run.id, error });
  }
  if (!source) return { error: MEDIA_UNAVAILABLE };
  const mediaGeneration = source.provider;
  const result = await generateMediaFromTool({
    name,
    args,
    executionId: applied?.effect.id ?? executionId,
    recoverOnly,
    provider: mediaGeneration,
    source: source.record,
    prisma: deps.prisma,
    context,
    run,
    threadGeneration: thread.historyCompactionGeneration,
    price: hostedMediaPrice(deps.prisma, source, run.spaceId),
    ...mediaDelivery({ ...deps, artifacts: deps.artifacts }, run, {
      providerId: mediaGeneration.id,
      groupId: await artifactGroupId(ctx),
      operationId: executionId,
    }),
  });
  // The run may end before the video does, so a background poll posts it when it is ready.
  if (
    result &&
    "jobId" in result &&
    result.jobId &&
    "status" in result &&
    (result.status === "queued" || result.status === "running")
  )
    await scheduleMediaPoll(deps.jobs, result.jobId);
  return result;
}

async function generateMedia(ctx: RunContext, call: ToolCall) {
  return call.finish(await callMediaTool(ctx, call));
}

/** Workspace files, attachments, plots and generated media. */
export const fileTools: ToolHandlers = {
  async list_files(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    const workspace = runWorkspace(ctx, call);
    return listFilesFromTool(deps.sandbox, workspace, args);
  },
  async read_file(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    const workspace = runWorkspace(ctx, call);
    return readFileFromTool(
      deps.sandbox,
      workspace,
      args,
      (path, maxBytes) => readStoppedRunFile(ctx, path, maxBytes),
      ctx.computer.modelSeesImages,
    );
  },
  async write_file(ctx, call) {
    const { deps, bot, context } = ctx;
    const { name, args } = call;
    const filePath = String(args.path ?? "notes/result.txt");
    const content = new TextEncoder().encode(textContentArg(args.content, ""));
    ctx.computer.checkpoint.markDirty();
    try {
      await deps.sandbox.writeFile(
        await ctx.computer.get("tool", name),
        { path: resolveBotWorkspacePath(ctx.computer.mode, bot.id, filePath), content },
        context,
      );
    } catch (error) {
      await recordComputerAction(ctx, call, "write_file", filePath, {
        error: error instanceof Error ? error.message : "could not write file",
      });
      throw error;
    }
    await recordComputerAction(ctx, call, "write_file", filePath, { bytes: content.byteLength });
    return call.finish({ ok: true, path: filePath });
  },
  generate_image: generateMedia,
  generate_video: generateMedia,
  async render_plot(ctx, call) {
    const { deps, run } = ctx;
    const { args, executionId } = call;
    const workspace = runWorkspace(ctx, call);
    return renderPlotFromTool(deps, run, args, executionId, workspace, call.finish);
  },
  async attach_file(ctx, call) {
    const { deps, run, bot } = ctx;
    const filePath = String(call.args.path ?? "");
    const fail = async (error: string) => {
      await recordComputerAction(ctx, call, "attach_file", filePath, { error });
      return call.finish({ error, path: filePath });
    };
    const read = await readWorkspaceFile(ctx, call, filePath);
    if ("error" in read) return fail(read.error);
    try {
      // Background runs post no message (publishMessage drops attachment blocks).
      const background = isBackgroundRunTrigger(run.trigger);
      const lease = runLeaseFor(deps, run.id);
      let committed: Awaited<ReturnType<typeof persistMessageInTransaction>> | undefined;
      const saved = await saveWorkspaceFile(
        ctx,
        call,
        filePath,
        read.bytes,
        { botId: bot.id, groupId: await artifactGroupId(ctx) },
        {
          name: typeof call.args.name === "string" ? call.args.name : undefined,
          description:
            typeof call.args.description === "string" ? call.args.description : undefined,
        },
        // The message commits with the artifact row, so a post that fails leaves no artifact
        // the user was never shown.
        background
          ? undefined
          : async (tx, artifact) => {
              committed = await persistMessageInTransaction(
                tx,
                run,
                "bot",
                [messageBlockForArtifact(artifact)],
                run.trigger === "bot_message" ? false : undefined,
                undefined,
                false,
                lease,
              );
            },
      );
      if (committed)
        await deps.events
          .notify(run.threadId, committed.eventSeq, committed.firstResponseRunId)
          .catch((error) => getLogger().error("thread message realtime notification", error));
      await recordComputerAction(ctx, call, "attach_file", filePath);
      return call.finish({ ok: true, artifactId: saved.artifactId, path: filePath });
    } catch (error) {
      return fail(error instanceof Error ? error.message : "could not attach file");
    }
  },
};

/** Read a file from this bot's computer that can become an attachment, without saving it. */
export async function readWorkspaceFile(
  ctx: RunContext,
  call: ToolCall,
  filePath: string,
): Promise<{ error: string } | { bytes: Uint8Array }> {
  const { deps, bot, context } = ctx;
  if (!deps.artifacts) return { error: "artifact storage unavailable" };
  let bytes: Uint8Array;
  try {
    bytes = await deps.sandbox.readFile(
      await ctx.computer.get("tool", call.name),
      resolveBotWorkspacePath(ctx.computer.mode, bot.id, filePath),
      context,
      { maxBytes: deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES },
    );
  } catch {
    return { error: "file not found or unreadable" };
  }
  if (!inferAttachmentMimeType(filePath)) return { error: "unsupported attachment type" };
  return { bytes };
}

/**
 * Save a file read from this bot's computer as an attachment of the chat that will show it:
 * a bot's own chat, or a group's.
 */
export async function saveWorkspaceFile(
  ctx: RunContext,
  call: ToolCall,
  filePath: string,
  bytes: Uint8Array,
  owner: { botId: string; groupId?: string },
  meta: { name?: string; description?: string } = {},
  onAttached?: (tx: Prisma.TransactionClient, artifact: Artifact) => Promise<void>,
): Promise<{ artifactId: string; block: AttachmentBlock }> {
  const { deps, run } = ctx;
  if (!deps.artifacts) throw new Error("artifact storage unavailable");
  return attachWorkspaceFileToThread(
    {
      prisma: deps.prisma,
      artifacts: deps.artifacts,
      maxUploadSizeBytes: deps.maxUploadSizeBytes,
      events: deps.events,
    },
    {
      spaceId: run.spaceId,
      userId: run.userId,
      botId: owner.botId,
      groupId: owner.groupId,
      runId: run.id,
      filePath,
      bytes,
      operationId: call.executionId,
      name: meta.name,
      description: meta.description,
      onAttached,
    },
  );
}
