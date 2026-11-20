import { createHash } from "node:crypto";
import type {
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import type { Actor, HostComputerCall, HostGrant } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { messageBlockForArtifact } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { ExternalEffect } from "@rakazo/db";
import { assertRunCanWriteHistory, isUniqueViolation, parseComputerMode } from "@rakazo/db";
import { quote } from "shell-quote";
import { BACKGROUND_WORK_LAUNCH } from "./../computers/computer-idle.js";
import { acquireComputerExecutionLease, provisionComputer } from "./../computers/computer-lifecycle.js";
import { resolveBotWorkspaceCwd, resolveBotWorkspacePath } from "./../computers/screens/computer-support.js";
import { persistMessageInTransaction } from "./../runs/assembly/run-messages.js";
import { attachWorkspaceFileToThread } from "./../storage/thread-artifacts.js";
import type { HostExecutionDeps } from "./host-execution.js";
import { authorizedHostExecution, HostExecutionError } from "./host-execution.js";

export interface HostComputerDeps extends HostExecutionDeps {
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  artifacts: ArtifactStore;
  dataDir?: string;
}

/** A native tool call is a single recorded dispatch. An unknown side effect is never retried. */
export async function executeHostComputerTool(
  deps: HostComputerDeps,
  who: { actor: Actor; sessionId?: string; signal?: AbortSignal },
  input: HostGrant & { id: string; call: HostComputerCall },
) {
  const { saved, run } = await authorizedHostExecution(deps, who, input);
  if (
    !saved.targetComputerId ||
    saved.terminal ||
    run.status !== "running" ||
    !run.leaseExpiresAt ||
    run.leaseExpiresAt <= new Date() ||
    run.bot.computerId !== saved.targetComputerId ||
    run.bot.computerSwitching
  )
    throw new HostExecutionError("CONFLICT", "Computer unavailable");
  const computer = await deps.prisma.computer.findFirst({
    where: {
      id: saved.targetComputerId,
      spaceId: who.actor.spaceId,
      OR: [{ scope: "team" }, { scope: "personal", userId: who.actor.userId }],
    },
  });
  if (!computer || computer.kind === "desktop" || computer.kind === "user-device")
    throw new HostExecutionError("FORBIDDEN");
  const fingerprint = stableJsonValue(input.call);
  const idempotencyKey = `host-tool:${createHash("sha256")
    .update(JSON.stringify([run.id, input.id]))
    .digest("hex")}`;
  let effect: ExternalEffect;
  try {
    effect = await deps.prisma.$transaction(async (tx) => {
      await assertRunCanWriteHistory(tx, run.id, {
        lease: { owner: saved.installationId, fence: run.leaseFence },
      });
      return tx.externalEffect.create({
        data: {
          spaceId: run.spaceId,
          runId: run.id,
          kind: "host_computer_tool",
          idempotencyKey,
          status: "intended",
          request: input.call,
        },
      });
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const previous = await deps.prisma.externalEffect.findUniqueOrThrow({
      where: { idempotencyKey },
    });
    if (stableJsonValue(previous.request) !== fingerprint) throw new HostExecutionError("CONFLICT");
    const result = previous.result as { text?: string } | null;
    return {
      result:
        result?.text ??
        JSON.stringify({
          error:
            "The previous operation's result is unknown. Inspect the computer before retrying.",
        }),
    };
  }
  const signal = AbortSignal.any([
    who.signal ?? new AbortController().signal,
    AbortSignal.timeout(45_000),
  ]);
  const context = {
    ...createAdapterContext(who.actor, run.botId, input.id),
    runId: run.id,
    signal,
  };
  try {
    await acquireComputerExecutionLease(deps.prisma, {
      computerId: computer.id,
      botId: run.botId,
      runId: run.id,
      workerId: saved.installationId,
      runFence: run.leaseFence,
    });
    const reference = await provisionComputer(deps, computer.id, context, "bot");
    // Provisioning can take long enough for a stop or revocation to win.
    const current = await authorizedHostExecution(deps, who, input);
    if (
      current.saved.terminal ||
      current.run.status !== "running" ||
      !current.run.leaseExpiresAt ||
      current.run.leaseExpiresAt <= new Date() ||
      current.run.bot.computerId !== computer.id
    )
      throw new HostExecutionError("CONFLICT");
    await deps.prisma.externalEffect.update({
      where: { id: effect.id },
      data: { status: "dispatched" },
    });
    const mode = parseComputerMode(computer.scope);
    const call = input.call;
    let result: unknown;
    if (call.name === "computer_execute") {
      const environment = await deps.sandbox.environment?.(reference, context);
      const marker = createHash("sha256").update(input.id).digest("hex");
      const argv = ["windows", "win32"].includes(environment?.platform ?? "")
        ? call.input.argv
        : [
            "bash",
            "-c",
            BACKGROUND_WORK_LAUNCH,
            "rakazo-background-launch",
            computer.id,
            run.id,
            marker,
            quote(call.input.argv),
          ];
      let stdout = "";
      let stderr = "";
      let code: number | undefined;
      for await (const event of deps.sandbox.execute(
        reference,
        {
          argv,
          cwd: resolveBotWorkspaceCwd(mode, run.botId, call.input.cwd),
          timeoutMs: 30_000,
        },
        context,
      )) {
        if (event.type === "stdout") stdout = (stdout + event.data).slice(-64_000);
        else if (event.type === "stderr") stderr = (stderr + event.data).slice(-64_000);
        else code = event.code;
      }
      if (code === undefined) throw new Error("unknown_command_result");
      result = { stdout, stderr, code };
    } else if (call.name === "computer_read_file") {
      const bytes = await deps.sandbox.readFile(
        reference,
        resolveBotWorkspacePath(mode, run.botId, call.input.path),
        context,
        { maxBytes: 128_000 },
      );
      if (bytes.byteLength > 128_000) throw new Error("file_too_large");
      result = { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } else if (call.name === "computer_write_file") {
      await deps.sandbox.writeFile(
        reference,
        {
          path: resolveBotWorkspacePath(mode, run.botId, call.input.path),
          content: Buffer.from(call.input.text),
        },
        context,
      );
      result = { written: true };
    } else if (call.name === "computer_attach_file") {
      if (current.run.bot.disabledBuiltinTools.includes("attach_file"))
        throw new HostExecutionError("FORBIDDEN");
      const bytes = await deps.sandbox.readFile(
        reference,
        resolveBotWorkspacePath(mode, run.botId, call.input.path),
        context,
        { maxBytes: ATTACHMENT_MAX_BYTES },
      );
      result = await attachWorkspaceFileToThread(deps, {
        spaceId: run.spaceId,
        userId: run.userId,
        botId: run.botId,
        runId: run.id,
        filePath: call.input.path,
        bytes,
        operationId: idempotencyKey,
        onAttached: async (tx, artifact) => {
          await assertRunCanWriteHistory(tx, run.id, {
            lease: { owner: saved.installationId, fence: run.leaseFence },
          });
          await persistMessageInTransaction(
            tx,
            run,
            "bot",
            [messageBlockForArtifact(artifact)],
            true,
            idempotencyKey,
            false,
            { owner: saved.installationId, fence: run.leaseFence },
          );
        },
      });
      const event = await deps.prisma.event.findFirst({
        where: { threadId: run.threadId, runId: run.id },
        orderBy: { seq: "desc" },
      });
      if (event) await deps.events.notify(run.threadId, event.seq);
    } else
      result = {
        files: (
          await deps.sandbox.listFiles(
            reference,
            resolveBotWorkspacePath(mode, run.botId, call.input.path),
            context,
          )
        ).slice(0, 500),
      };
    const text = JSON.stringify(result);
    await deps.prisma.externalEffect.update({
      where: { id: effect.id },
      data: { status: "completed", result: { text } },
    });
    return { result: text };
  } catch {
    const text = JSON.stringify({
      error: "The operation did not finish reliably. Inspect the computer before retrying.",
    });
    await deps.prisma.externalEffect.update({
      where: { id: effect.id },
      data: { status: "uncertain", result: { text } },
    });
    return { result: text };
  }
}
