import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { ComputerCommand } from "@rakazo/contracts";
import { COMPUTER_COMMAND_OUTPUT_MAX_CHARS } from "@rakazo/contracts";
import { redactSecrets, sandboxCommandTimeoutMs } from "@rakazo/core";
import { RunHistoryWriteError, releasePayment } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { redactShellStreams } from "./agent-environment.js";
import {
  resolveCodeFill,
  resolveLoginFill,
  resolveVaultCardFill,
  shellCommandEnvironment,
} from "./bot-secrets.js";
import {
  browserActFromTool,
  browserNavigateFromTool,
  browserResultForModel,
  browserSnapshotFromTool,
  redactBrowserResult,
} from "./browser-tools.js";
import { BACKGROUND_WORK_LAUNCH } from "./computer-idle.js";
import {
  displayBotWorkspacePath,
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
  desktopGuardApplies,
  desktopProtectionGuardMessage,
  protectedComputerLifecycleRefusal,
} from "./desktop-command-guard.js";
import { nativeShellCommandArgv, usesNativeShell } from "./native-shell.js";
import { purchaseApprovalOf } from "./purchase-gate.js";
import { resolvePurchaseCardFill, resolvePurchasePayTokenFill } from "./purchase-service.js";
import type { RunContext } from "./run-context.js";
import { addRunSecrets } from "./run-context.js";
import { builtinOffered } from "./run-instructions.js";
import { computerScreenToolResult } from "./run-lifecycle.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { auditToolCall } from "./run-tool-gate.js";
import { awaitScreenTurn, SCREEN_ACTION_MS } from "./screen-turn.js";
import {
  isRunningShellCommand,
  observeShellCommand,
  SHELL_STILL_RUNNING_NOTICE,
} from "./shell-command-stream.js";
import { recordPagePayment } from "./spending-gate.js";
import { DESKTOP_HELD_FOR_TAKEOVER_MESSAGE } from "./takeover-resume.js";
import { getActiveTeachingSession } from "./teaching-session.js";
import { vaultCardUseOf } from "./vault-card-use.js";

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
  screen.turn.mustLook = false;
  return result;
}

type ScreenTurnResult = { error: string } | { end: () => Promise<void> };

/**
 * Wait for this bot's turn on its screen. A turn marks the computer while the action runs, so a
 * person taking control waits for it to end; call `end` when the action is over.
 */
async function takeScreenTurn(ctx: RunContext, look = false): Promise<ScreenTurnResult> {
  if (ctx.computer.heldForTakeover) return { error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE };
  if (await getActiveTeachingSession(ctx.deps.prisma, ctx.run.spaceId, ctx.run.botId)) {
    return { error: "Teaching is in progress. Stop teaching before using the computer." };
  }
  const { prisma } = ctx.deps;
  const computerId = ctx.computer.stored.id;
  const botId = ctx.bot.id;
  let marked: Date | undefined;
  // The mark lasts as long as the action: it is renewed while the action runs, and lapses on its
  // own only if this worker dies.
  const renew = async () => {
    if (!marked) return;
    const until = new Date(Date.now() + SCREEN_ACTION_MS);
    const renewed = await prisma.$executeRaw`
      UPDATE computer_execution_leases SET "screenActionUntil" = ${until}
      WHERE "computerId" = ${computerId} AND "botId" = ${botId}
        AND "screenActionUntil" = ${marked}`;
    if (renewed === 1) marked = until;
  };
  let renewing: ReturnType<typeof setInterval> | undefined;
  const end = async () => {
    clearInterval(renewing);
    if (!marked) return;
    const until = marked;
    marked = undefined;
    await prisma.$executeRaw`
      UPDATE computer_execution_leases SET "screenActionUntil" = NULL
      WHERE "computerId" = ${computerId} AND "botId" = ${botId}
        AND "screenActionUntil" = ${until}`;
  };
  const { signal } = ctx.context;
  const refused = await awaitScreenTurn({
    turn: ctx.state.screen.turn,
    look,
    readControl: async () => {
      const until = new Date(Date.now() + SCREEN_ACTION_MS);
      // Mark this bot's action in the same statement that finds no person on its screen. A
      // person's lease counts until it is cleared, which happens only after the provider has
      // stopped their input, even once it has lapsed. The computer row is locked, as Take
      // control locks it, so one of the two always sees the other. Raw SQL leaves updatedAt
      // alone.
      const [free] = await prisma.$queryRaw<Array<{ controlFence: number }>>`
        UPDATE computer_execution_leases AS l SET "screenActionUntil" = ${until}
        FROM (
          SELECT id, "controlFence" FROM computers
          WHERE id = ${computerId}
            AND ("controlHolder" <> 'user' OR "controlBotId" IS NULL
              OR "controlBotId" <> ${botId} OR "controlLeaseId" IS NULL)
          FOR UPDATE
        ) AS c
        WHERE l."computerId" = c.id AND l."botId" = ${botId}
        RETURNING c."controlFence"`;
      if (free) {
        marked = until;
        return { held: false, fence: free.controlFence };
      }
      const computer = await prisma.computer.findUnique({
        where: { id: computerId },
        select: {
          controlHolder: true,
          controlLeaseId: true,
          controlBotId: true,
          controlFence: true,
        },
      });
      if (!computer) return null;
      // Without a lease row there is no mark to make, and the action goes ahead unmarked.
      return {
        held:
          computer.controlHolder === "user" &&
          Boolean(computer.controlLeaseId) &&
          computer.controlBotId === botId,
        fence: computer.controlFence,
      };
    },
    sleep: (ms) => sleep(ms, undefined, { signal }),
  });
  if (refused) {
    await end();
    return { error: refused };
  }
  renewing = setInterval(() => {
    renew().catch((error: unknown) => getLogger().warn("screen action mark renewal", { error }));
  }, SCREEN_ACTION_MS / 3);
  return { end };
}

/** Run a screen tool in this bot's turn, or answer with why it may not use the screen. */
async function withScreenTurn<T>(
  ctx: RunContext,
  look: boolean,
  refuse: (error: string) => T | Promise<T>,
  run: () => Promise<T>,
): Promise<T> {
  const turn = await takeScreenTurn(ctx, look);
  if ("error" in turn) return refuse(turn.error);
  try {
    return await run();
  } finally {
    await turn.end();
  }
}

/**
 * Count the call's approved payment against the user's spending limit, just before its press.
 * Returns why it may not go ahead: over the limit, or the limit could not be checked.
 */
async function countPayment(ctx: RunContext, call: ToolCall): Promise<string | undefined> {
  if (!call.spend) return undefined;
  try {
    const spender = {
      userId: ctx.run.userId,
      spaceId: ctx.run.spaceId,
      botId: ctx.bot.id,
      threadId: ctx.thread.id,
    };
    const refused = await recordPagePayment(ctx.deps.prisma, spender, call.spend, call.effectKey);
    if (refused) await auditToolCall(ctx, call.name, "denied", { reason: "spending_limit" });
    return refused;
  } catch (error) {
    ctx.context.signal.throwIfAborted();
    getLogger().warn("spending limit could not be checked", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return "The user's spending limit couldn't be checked, so nothing was paid. Try again.";
  }
}

/** Stop counting the call's payment: its press clearly never happened. */
function releaseUnpressedPayment(ctx: RunContext, call: ToolCall): Promise<void> {
  return call.spend
    ? releasePayment(ctx.deps.prisma, call.effectKey).catch((error: unknown) =>
        getLogger().warn("unpaid purchase could not be released", {
          errorName: error instanceof Error ? error.name : typeof error,
        }),
      )
    : Promise.resolve();
}

export async function pageBrowserTool(ctx: RunContext, call: ToolCall) {
  const { deps, run, bot, context } = ctx;
  const { name, args } = call;
  if (name !== "browser_snapshot") ctx.computer.checkpoint.markDirty();
  // Pages can echo a filled login (e.g. a username field), so scrub every page result.
  const redactions = () => [...ctx.secrets];
  const desktopTools =
    ctx.computer.graphicalToolsAllowed && builtinOffered(ctx.tools.disabled, "computer_act");
  // A file the page downloads goes to the bot's own Downloads folder. Its name is redacted like any
  // page text, so one that echoes a secret is listed under another name than it has on disk.
  const downloads = {
    folder: resolveBotWorkspacePath(ctx.computer.mode, bot.id, "Downloads"),
    botPath: (path: string) =>
      displayBotWorkspacePath(ctx.computer.mode, bot.id, "Downloads", path),
  };
  const tool =
    name === "browser_navigate"
      ? browserNavigateFromTool
      : name === "browser_snapshot"
        ? browserSnapshotFromTool
        : null;
  const look = name === "browser_snapshot";
  return withScreenTurn(
    ctx,
    look,
    (error) => call.finish({ error }),
    () =>
      computerScreenToolResult(async () => {
        // A call that presses an approved purchase spends it: a card it types leaves no pass for the next one.
        const paying = purchaseApprovalOf(args.purchaseApproval);
        const result = tool
          ? redactBrowserResult(
              await tool(
                ctx.providers.browser,
                await ctx.computer.get("tool", name),
                context,
                args,
                {
                  desktopTools,
                  downloads,
                },
              ),
              redactions(),
            )
          : await browserActFromTool(
              ctx.providers.browser,
              await ctx.computer.get("tool", name),
              context,
              args,
              {
                desktopTools,
                downloads,
                redactions,
                approvedPurchase: paying,
                countPurchase: () => countPayment(ctx, call),
                releasePurchase: () => releaseUnpressedPayment(ctx, call),
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
                  if ("card" in step) {
                    // Only the card and checkout the person approved for this call.
                    const approvedCard = vaultCardUseOf(args.cardApproval);
                    if (approvedCard?.card !== step.card || approvedCard.site !== step.site)
                      return { error: "The user has not approved typing this card here." };
                    const resolved = await resolveVaultCardFill({
                      prisma: deps.prisma,
                      secretStore: deps.secretStore,
                      scope: run,
                      name: step.card,
                      field: step.field,
                      site: step.site,
                      savedAt: approvedCard.savedAt,
                    });
                    if ("error" in resolved) return resolved;
                    addRunSecrets(ctx, resolved.redactions);
                    // No pass for the pay click: approving the card named no amount, so the click
                    // that places the order still asks, showing what the page charges.
                    return { text: resolved.text, origin: resolved.origin };
                  }
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
                  if (!paying) ctx.state.walletHosts.add(new URL(resolved.origin).host);
                  return { text: resolved.text, origin: resolved.origin };
                },
                resolveCodeFill: async () => {
                  const resolved = await resolveCodeFill({
                    prisma: deps.prisma,
                    secretStore: deps.secretStore,
                    scope: run,
                    runId: run.id,
                  });
                  if ("error" in resolved) return resolved;
                  addRunSecrets(ctx, resolved.redactions);
                  const { text, origin, claim, restore } = resolved;
                  return { text, origin, claim, restore };
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
                  if (!paying) ctx.state.walletHosts.add(new URL(origin).host);
                  return { text, origin, merchantAccountId };
                },
              },
            );
        // A snapshot saves the PDF its tab shows, which is a new file on the computer.
        if ((result as { downloads?: unknown } | null)?.downloads)
          ctx.computer.checkpoint.markDirty();
        ctx.state.screen.unchangedVisualStreak = unchangedVisualStreakAfterPageBrowser(
          ctx.state.screen.unchangedVisualStreak,
          name,
          result,
        );
        // A snapshot that returned the page is the fresh look a person's use asked for.
        if (name === "browser_snapshot" && !(result as { error?: unknown } | null)?.error) {
          ctx.state.screen.turn.mustLook = false;
        }
        return browserResultForModel(result);
      }, call.finish),
  );
}

/** Tools that drive the bot's computer: screen, page browser and shell. */
export const computerTools: ToolHandlers = {
  async computer_observe(ctx, call) {
    const { deps, context } = ctx;
    const { name } = call;
    return withScreenTurn(
      ctx,
      true,
      (error) => ({ error }),
      () =>
        computerScreenToolResult(async () =>
          formatObservation(
            ctx,
            await deps.sandbox.observe(await ctx.computer.get("tool", name), context),
          ),
        ),
    );
  },
  async computer_act(ctx, call) {
    const { deps, context } = ctx;
    const { name, args } = call;
    return withScreenTurn(
      ctx,
      false,
      (error) => ({ error }),
      async () => {
        const actions = parseComputerActions(args.actions);
        const visualActionKey = computerVisualActionKey(actions);
        if (unchangedVisualActionBlocked(ctx.state.screen.unchangedVisualStreak, actions)) {
          return call.finish(unchangedVisualLoopToolResult(ctx.state.screen.unchangedVisualStreak));
        }
        ctx.computer.checkpoint.markDirty();
        return computerScreenToolResult(async () => {
          const computer = await ctx.computer.get("tool", name);
          // Counted just before the press; a desktop press is never known not to have happened.
          const refused = await countPayment(ctx, call);
          if (refused) return { error: refused };
          const result = await deps.sandbox.act(
            computer,
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
    );
  },
  async shell(ctx, call) {
    const { deps, run, runId, bot, context } = ctx;
    const { name, args, executionId, observer } = call;
    const command = String(args.command ?? args.cmd ?? "");
    const refusal = protectedComputerLifecycleRefusal(command);
    if (desktopGuardApplies(ctx.computer) && refusal) {
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
        (usesNativeShell(computer.kind)
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
    return withScreenTurn(
      ctx,
      false,
      (error) => call.finish({ error }),
      async () => {
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
    );
  },
  async launch_app(ctx, call) {
    const { deps, context } = ctx;
    const { name, args } = call;
    return withScreenTurn(
      ctx,
      false,
      (error) => call.finish({ error }),
      async () => {
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
    );
  },
};
