import { randomUUID } from "node:crypto";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { ComputerCommand } from "@rakazo/contracts";
import { COMPUTER_COMMAND_OUTPUT_MAX_CHARS } from "@rakazo/contracts";
import { redactSecrets, sandboxCommandTimeoutMs } from "@rakazo/core";
import { RunHistoryWriteError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { redactShellStreams } from "./agent-environment.js";
import { resolveLoginFill, shellCommandEnvironment } from "./bot-secrets.js";
import {
  browserActFromTool,
  browserNavigateFromTool,
  browserResultForModel,
  browserSnapshotFromTool,
  redactBrowserResult,
} from "./browser-tools.js";
import { BACKGROUND_WORK_LAUNCH } from "./computer-idle.js";
import {
  resolveBotUploadPath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  teamBotWorkspaceDirectory,
} from "./computer-support.js";
import {
  advanceUnchangedVisualGuard,
  computerVisualActionKey,
  observationToolResult,
  parseComputerActions,
  unchangedVisualActionBlocked,
  unchangedVisualLoopToolResult,
  unchangedVisualStreakAfterPageBrowser,
} from "./computer-tools.js";
import {
  desktopProtectionGuardMessage,
  protectedComputerLifecycleRefusal,
} from "./desktop-command-guard.js";
import { nativeShellCommandArgv } from "./native-shell.js";
import { resolvePurchaseCardFill, resolvePurchasePayTokenFill } from "./purchase-service.js";
import type { RunContext } from "./run-context.js";
import { addRunSecrets } from "./run-context.js";
import { builtinOffered } from "./run-instructions.js";
import { computerScreenToolResult } from "./run-lifecycle.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import {
  isRunningShellCommand,
  observeShellCommand,
  SHELL_STILL_RUNNING_NOTICE,
} from "./shell-command-stream.js";
import { DESKTOP_HELD_FOR_TAKEOVER_MESSAGE } from "./takeover-resume.js";
import { getActiveTeachingSession } from "./teaching-session.js";

function appendComputerCommand(ctx: RunContext, payload: ComputerCommand) {
  const { deps, run, runId, bot, thread } = ctx;
  return (
    deps.events
      .append({
        spaceId: run.spaceId,
        threadId: thread.id,
        botId: bot.id,
        runId,
        type: "computer.command",
        payload,
      })
      // The Activity feed is a view; losing an entry must not fail the tool.
      // Output that arrives after the run was cancelled has no history to join.
      .catch((error: unknown) => {
        if (!(error instanceof RunHistoryWriteError)) {
          getLogger().error("computer command event", error);
        }
      })
  );
}

/** Record a finished file/app action for the terminal's Activity view. */
export function recordComputerAction(
  ctx: RunContext,
  call: ToolCall,
  kind: Exclude<ComputerCommand["kind"], "shell">,
  target: string,
  outcome: { error?: string; bytes?: number } = {},
) {
  return appendComputerCommand(ctx, {
    executionId: call.executionId,
    kind,
    command: redactSecrets(target, ctx.secrets),
    cwd: ".",
    status: "done",
    exitCode: outcome.error ? 1 : 0,
    output: outcome.error ? redactSecrets(outcome.error, ctx.secrets) : "",
    ...(outcome.bytes === undefined ? {} : { bytes: outcome.bytes }),
  });
}

function formatObservation(
  ctx: RunContext,
  observation: Awaited<ReturnType<SandboxProvider["observe"]>>,
  note?: string,
  visualActionKey?: string,
) {
  const { screen } = ctx.state;
  const guard = advanceUnchangedVisualGuard(
    screen.unchangedVisualStreak,
    observation.frameId,
    visualActionKey,
  );
  screen.unchangedVisualStreak = guard.streak;
  // A browser window's title is the page title, which can echo a signed-in username.
  const activeWindow = observation.activeWindow;
  const result = observationToolResult(
    activeWindow?.title
      ? {
          ...observation,
          activeWindow: {
            ...activeWindow,
            title: redactSecrets(activeWindow.title, ctx.secrets),
          },
        }
      : observation,
    note,
    screen.lastFrameId,
    visualActionKey ? { unchangedVisualCount: guard.streak.count } : undefined,
  );
  screen.lastFrameId = observation.frameId;
  return result;
}

async function screenBlocked(ctx: RunContext): Promise<string | undefined> {
  if (ctx.computer.heldForTakeover) return DESKTOP_HELD_FOR_TAKEOVER_MESSAGE;
  if (await getActiveTeachingSession(ctx.deps.prisma, ctx.run.spaceId, ctx.run.botId)) {
    return "Teaching is in progress. Stop teaching before using the computer.";
  }
  return undefined;
}

export async function pageBrowserTool(ctx: RunContext, call: ToolCall) {
  const { deps, run, bot, context } = ctx;
  const { name, args } = call;
  const blocked = await screenBlocked(ctx);
  if (blocked) return call.finish({ error: blocked });
  if (name !== "browser_snapshot") ctx.computer.checkpoint.markDirty();
  // Pages can echo a filled login (e.g. a username field), so scrub every page result.
  const redactions = () => [...ctx.secrets];
  const desktopTools =
    ctx.computer.graphicalToolsAllowed && builtinOffered(ctx.tools.disabled, "computer_act");
  const tool =
    name === "browser_navigate"
      ? browserNavigateFromTool
      : name === "browser_snapshot"
        ? browserSnapshotFromTool
        : null;
  return computerScreenToolResult(async () => {
    const result = tool
      ? redactBrowserResult(
          await tool(ctx.providers.browser, await ctx.computer.get("tool", name), context, args, {
            desktopTools,
          }),
          redactions(),
        )
      : await browserActFromTool(
          ctx.providers.browser,
          await ctx.computer.get("tool", name),
          context,
          args,
          {
            desktopTools,
            redactions,
            // Team bots may send only their own folder or shared/ off the computer; a
            // private computer's helper already confines uploads to its home folder.
            uploadRoots:
              ctx.computer.mode === "team"
                ? [teamBotWorkspaceDirectory(bot.id), "shared"]
                : undefined,
            resolveUploadPath: (path) =>
              ctx.computer.mode === "team"
                ? resolveBotUploadPath(ctx.computer.mode, bot.id, path)
                : path,
            resolveSecretFill: async (step) => {
              const resolved = await resolveLoginFill({
                prisma: deps.prisma,
                secretStore: deps.secretStore,
                scope: run,
                runId: run.id,
                name: step.secret,
                field: step.field,
              });
              if ("error" in resolved) return resolved;
              addRunSecrets(ctx, resolved.redactions);
              return { text: resolved.text, origin: resolved.origin, hidden: resolved.hidden };
            },
            resolveCardFill: async (step) => {
              const paymentWallet = deps.paymentWallet;
              if (!paymentWallet) return { error: "Card fills are unavailable here." };
              const resolved = await resolvePurchaseCardFill(
                { prisma: deps.prisma, secretStore: deps.secretStore, paymentWallet },
                run,
                step.purchase,
                step.field,
              );
              if ("error" in resolved) return resolved;
              addRunSecrets(ctx, resolved.redactions);
              return { text: resolved.text, origin: resolved.origin };
            },
            resolvePayTokenFill: async (step) => {
              const paymentWallet = deps.paymentWallet;
              if (!paymentWallet) return { error: "Pay tokens are unavailable here." };
              const resolved = await resolvePurchasePayTokenFill(
                { prisma: deps.prisma, secretStore: deps.secretStore, paymentWallet },
                run,
                step.purchase,
              );
              if ("error" in resolved) return resolved;
              addRunSecrets(ctx, resolved.redactions);
              const { text, origin, merchantAccountId } = resolved;
              return { text, origin, merchantAccountId };
            },
          },
        );
    ctx.state.screen.unchangedVisualStreak = unchangedVisualStreakAfterPageBrowser(
      ctx.state.screen.unchangedVisualStreak,
      name,
      result,
    );
    return browserResultForModel(result);
  }, call.finish);
}

/** Tools that drive the bot's computer: screen, page browser and shell. */
export const computerTools: ToolHandlers = {
  async computer_observe(ctx, call) {
    const { deps, context } = ctx;
    const { name } = call;
    const blocked = await screenBlocked(ctx);
    if (blocked) return { error: blocked };
    return computerScreenToolResult(async () =>
      formatObservation(
        ctx,
        await deps.sandbox.observe(await ctx.computer.get("tool", name), context),
      ),
    );
  },
  async computer_act(ctx, call) {
    const { deps, context } = ctx;
    const { name, args } = call;
    const blocked = await screenBlocked(ctx);
    if (blocked) return { error: blocked };
    const actions = parseComputerActions(args.actions);
    const visualActionKey = computerVisualActionKey(actions);
    if (unchangedVisualActionBlocked(ctx.state.screen.unchangedVisualStreak, actions)) {
      return call.finish(unchangedVisualLoopToolResult(ctx.state.screen.unchangedVisualStreak));
    }
    ctx.computer.checkpoint.markDirty();
    return computerScreenToolResult(async () => {
      const result = await deps.sandbox.act(
        await ctx.computer.get("tool", name),
        {
          actions,
          observe: args.observe !== false,
          settleMs: Number(args.settle_ms ?? 350),
        },
        context,
      );
      return result.observation
        ? formatObservation(
            ctx,
            result.observation,
            `completed ${result.completed} computer action${result.completed === 1 ? "" : "s"}`,
            visualActionKey,
          )
        : { ok: true, completed: result.completed };
    }, call.finish);
  },
  async shell(ctx, call) {
    const { deps, run, runId, bot, context } = ctx;
    const { name, args, executionId, observer } = call;
    const command = String(args.command ?? args.cmd ?? "");
    const refusal = protectedComputerLifecycleRefusal(command);
    if (ctx.computer.graphical && refusal) {
      return call.finish({ error: desktopProtectionGuardMessage(refusal) });
    }
    const cwd = resolveBotWorkspaceCwd(
      ctx.computer.mode,
      bot.id,
      args.cwd ? String(args.cwd) : undefined,
    );
    // Loaded per command so a command variable added, replaced, or removed mid-run
    // applies to the next command. Registered for redaction before anything runs.
    const commandEnvironment = await shellCommandEnvironment({
      prisma: deps.prisma,
      secretStore: deps.secretStore,
      scope: run,
      registerRedactions: (values) => addRunSecrets(ctx, values),
    });
    ctx.computer.checkpoint.markDirty();
    const commandEvent = {
      executionId,
      kind: "shell" as const,
      command: redactSecrets(command, ctx.secrets),
      cwd: redactSecrets(cwd ?? ".", ctx.secrets),
    };
    await appendComputerCommand(ctx, {
      ...commandEvent,
      status: "running",
      exitCode: null,
      output: "",
    });
    try {
      let latestOutput = "";
      let lastPublishedAt = 0;
      let publishTimer: ReturnType<typeof setTimeout> | undefined;
      const clearPublishTimer = () => {
        if (publishTimer) clearTimeout(publishTimer);
        publishTimer = undefined;
      };
      const publishRunning = (output: string, immediate = false) => {
        latestOutput = output.slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS);
        const send = () => {
          clearPublishTimer();
          lastPublishedAt = Date.now();
          void appendComputerCommand(ctx, {
            ...commandEvent,
            status: "running",
            exitCode: null,
            output: latestOutput,
          });
        };
        if (immediate || Date.now() - lastPublishedAt >= 400) {
          send();
          return;
        }
        if (!publishTimer) publishTimer = setTimeout(send, 400);
      };
      const commandOutput = (
        snapshot: { stdout: string; stderr: string },
        withholdPartial: boolean,
      ) => {
        const safe = redactShellStreams(snapshot, ctx.secrets, { withholdPartial });
        return `${safe.stdout}${safe.stderr}`;
      };
      const computer = await ctx.computer.get("tool", name);
      const shellEnvironment =
        ctx.computer.hostEnvironment ??
        (computer.kind === "desktop"
          ? await deps.sandbox.environment?.(computer, context)
          : undefined);
      const observed = await observeShellCommand(
        deps.sandbox.execute(
          computer,
          {
            argv: shellEnvironment
              ? nativeShellCommandArgv(command, shellEnvironment)
              : [
                  "bash",
                  "-c",
                  BACKGROUND_WORK_LAUNCH,
                  "rakazo-background-launch",
                  // Marker id must match sleepComputerIfIdle's probe (DB id), not ComputerRef.id
                  // (providerRef via toComputerRef). Scope launches to this run for cancel teardown.
                  ctx.computer.stored.id,
                  runId,
                  randomUUID(),
                  command,
                ],
            cwd,
            env:
              Object.keys(commandEnvironment.env).length > 0 ? commandEnvironment.env : undefined,
            unsetEnv: commandEnvironment.unsetEnv,
            timeoutMs: sandboxCommandTimeoutMs(),
          },
          context,
        ),
        {
          secrets: ctx.secrets,
          onOutput: (snapshot) => {
            const output = commandOutput(snapshot, true);
            if (output) publishRunning(output);
          },
        },
      );
      if (observed.completion) {
        const completion = observed.completion.then(async (final) => {
          clearPublishTimer();
          await appendComputerCommand(ctx, {
            ...commandEvent,
            status: "done",
            exitCode: final.code,
            output: commandOutput(final, false).slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS),
          });
          return final;
        });
        void completion.catch(() => undefined);
        publishRunning(commandOutput(observed.result, true), true);
        const returned = await call.finish({
          stdout: observed.result.stdout,
          stderr: observed.result.stderr,
          code: null,
          running: true,
          notice: SHELL_STILL_RUNNING_NOTICE,
        });
        if (isRunningShellCommand(returned)) observer?.onShellStillRunning?.(completion);
        return returned;
      }
      clearPublishTimer();
      const redacted = observed.result;
      await appendComputerCommand(ctx, {
        ...commandEvent,
        status: "done",
        exitCode: redacted.code,
        output: commandOutput(redacted, false).slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS),
      });
      return call.finish(redacted);
    } catch (error) {
      await appendComputerCommand(ctx, {
        ...commandEvent,
        status: "done",
        exitCode: 1,
        output: redactSecrets(
          error instanceof Error ? error.message : "command failed",
          ctx.secrets,
        ).slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS),
      });
      throw error;
    }
  },
  async open_path(ctx, call) {
    const { deps, bot, context } = ctx;
    const { name, args } = call;
    const blocked = await screenBlocked(ctx);
    if (blocked) return call.finish({ error: blocked });
    const requestedPath = String(args.path ?? "");
    ctx.computer.checkpoint.markDirty();
    return computerScreenToolResult(async () => {
      try {
        const result = await deps.sandbox.act(
          await ctx.computer.get("tool", name),
          {
            actions: [
              {
                kind: "open",
                path: /^https?:\/\//i.test(requestedPath)
                  ? requestedPath
                  : resolveBotWorkspacePath(ctx.computer.mode, bot.id, requestedPath),
              },
            ],
            observe: true,
            settleMs: 600,
          },
          context,
        );
        await recordComputerAction(ctx, call, "open_path", requestedPath);
        return result.observation
          ? formatObservation(ctx, result.observation, `opened ${requestedPath}`)
          : { ok: true };
      } catch (error) {
        await recordComputerAction(ctx, call, "open_path", requestedPath, {
          error: error instanceof Error ? error.message : "could not open path",
        });
        throw error;
      }
    }, call.finish);
  },
  async launch_app(ctx, call) {
    const { deps, context } = ctx;
    const { name, args } = call;
    const blocked = await screenBlocked(ctx);
    if (blocked) return call.finish({ error: blocked });
    const application = String(args.application ?? "");
    ctx.computer.checkpoint.markDirty();
    return computerScreenToolResult(async () => {
      try {
        const result = await deps.sandbox.act(
          await ctx.computer.get("tool", name),
          {
            actions: [
              {
                kind: "focus",
                application,
                uri: args.uri ? String(args.uri) : undefined,
              },
            ],
            observe: true,
            settleMs: 600,
          },
          context,
        );
        await recordComputerAction(ctx, call, "launch_app", application);
        return result.observation
          ? formatObservation(ctx, result.observation, `launched ${application}`)
          : { ok: true };
      } catch (error) {
        await recordComputerAction(ctx, call, "launch_app", application, {
          error: error instanceof Error ? error.message : "could not launch app",
        });
        throw error;
      }
    }, call.finish);
  },
};
