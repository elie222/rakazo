import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { inferAttachmentMimeType, isBackgroundRunTrigger } from "@rakazo/core";
import { resolveBotWorkspacePath } from "./computer-support.js";
import { desktopGuardApplies, desktopProtectionGuardMessage } from "./desktop-command-guard.js";
import { protectedActivateScriptWriteRefusal } from "./desktop-guard-words.js";
import { generateMediaFromTool } from "./media-generation-tools.js";
import { mediaDelivery, scheduleMediaPoll } from "./media-video-poll.js";
import type { RunContext } from "./run-context.js";
import { publishMessage } from "./run-messages.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { recordComputerAction } from "./run-tools-computer.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";
import { textContentArg } from "./tool-text.js";
import type { RunWorkspace } from "./workspace-file-tools.js";
import { listFilesFromTool, readFileFromTool, renderPlotFromTool } from "./workspace-file-tools.js";

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

/** Generate an image or video, or with recoverOnly, only resume a job an earlier attempt started. */
export async function callMediaTool(ctx: RunContext, call: ToolCall, recoverOnly = false) {
  const { deps, run, thread, context } = ctx;
  const { name, args, executionId, applied } = call;
  const mediaGeneration = ctx.providers.mediaGeneration;
  if (
    (name !== "generate_image" && name !== "generate_video") ||
    isBackgroundRunTrigger(run.trigger) ||
    !mediaGeneration ||
    !deps.artifacts
  )
    return { error: "Media generation is unavailable." };
  const result = await generateMediaFromTool({
    name,
    args,
    executionId: applied?.effect.id ?? executionId,
    recoverOnly,
    provider: mediaGeneration,
    prisma: deps.prisma,
    context,
    run,
    threadGeneration: thread.historyCompactionGeneration,
    ...mediaDelivery({ ...deps, artifacts: deps.artifacts }, run, {
      providerId: mediaGeneration.id,
      groupId: thread.groupId ?? undefined,
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
    return readFileFromTool(deps.sandbox, workspace, args);
  },
  async write_file(ctx, call) {
    const { deps, bot, context } = ctx;
    const { name, args } = call;
    const filePath = String(args.path ?? "notes/result.txt");
    if (desktopGuardApplies(ctx.computer)) {
      const activateRefusal = protectedActivateScriptWriteRefusal(filePath);
      if (activateRefusal) {
        return call.finish({ error: desktopProtectionGuardMessage(activateRefusal) });
      }
    }
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
    const { deps, run, bot, thread, context } = ctx;
    const { name, args, executionId } = call;
    const filePath = String(args.path ?? "");
    const failAttach = async (error: string) => {
      await recordComputerAction(ctx, call, "attach_file", filePath, { error });
      return call.finish({ error, path: filePath });
    };
    if (!deps.artifacts) return failAttach("artifact storage unavailable");
    const storedPath = resolveBotWorkspacePath(ctx.computer.mode, bot.id, filePath);
    let bytes: Uint8Array;
    try {
      bytes = await deps.sandbox.readFile(
        await ctx.computer.get("tool", name),
        storedPath,
        context,
        {
          maxBytes: deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES,
        },
      );
    } catch {
      return failAttach("file not found or unreadable");
    }
    const mimeType = inferAttachmentMimeType(filePath);
    if (!mimeType) return failAttach("unsupported attachment type");
    try {
      const attached = await attachWorkspaceFileToThread(
        {
          prisma: deps.prisma,
          artifacts: deps.artifacts,
          maxUploadSizeBytes: deps.maxUploadSizeBytes,
        },
        {
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          groupId: thread.groupId ?? undefined,
          runId: run.id,
          filePath,
          bytes,
          operationId: executionId,
          name: typeof args.name === "string" ? args.name : undefined,
          description: typeof args.description === "string" ? args.description : undefined,
        },
      );
      await publishMessage(deps, run, "bot", [attached.block]);
      await recordComputerAction(ctx, call, "attach_file", filePath);
      return call.finish({ ok: true, artifactId: attached.artifactId, path: filePath });
    } catch (error) {
      return failAttach(error instanceof Error ? error.message : "could not attach file");
    }
  },
};
