import path from "node:path";
import type { AgentToolExecutionResult, ProcessEvent } from "@rakazo/adapter-kit";
import type { ApprovalMode } from "@rakazo/core";
import { BOT_MESSAGE_MAX_HOPS, HELPER_RESULT_TRIGGER, redactSecrets } from "@rakazo/core";
import { sandboxCommandTimeoutMs } from "@rakazo/core/node/sandbox-command";
import type { PrismaClient } from "@rakazo/db";
import { mayBeChannelMessage, readMessageBlocks } from "@rakazo/db";
import { z } from "zod";
import type { HostComputerEnvironment } from "../../computers/host/host-computer-protocol.js";
import { nativeShellCommandArgv } from "../../computers/host/native-shell.js";
import {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_SCREEN_TOOLS,
  USER_COMPUTER_SHELL_TOOL,
  USER_COMPUTER_TOOLS,
  userComputerAppName,
} from "../../computers/host/user-computer-tools.js";
import {
  isRunningShellCommand,
  observeShellCommand,
  SHELL_STILL_RUNNING_NOTICE,
} from "../../computers/sandbox/shell-command-stream.js";
import type {
  HostScreenAction,
  HostScreenActResult,
  HostScreenObservation,
} from "../../computers/screens/host-screen.js";
import { HOST_SCREEN_MAX_ACTIONS, hostScreenAction } from "../../computers/screens/host-screen.js";
import { messagingMessageClientNonce } from "../../messaging/intake/messaging-nonce.js";
import { ROUTINE_WATCH_NOTE_START } from "../../routines/routine-watch.prompt.js";
import type { RunContext } from "../assembly/run-context.js";
import { isRunTaintedBeyondOwnComputer } from "../assembly/run-context.js";
import { loadRunOrigin } from "../lifecycle/run-origin.js";
import type { ToolCall } from "./run-tool-gate.js";

export {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_SCREEN_TOOLS,
  USER_COMPUTER_SHELL_TOOL,
  USER_COMPUTER_TOOLS,
  userComputerAppName,
};

/** Whether the run's owner has their desktop connected, or could connect one. */
export type UserComputerState = "connected" | "offline" | undefined;

const USER_COMPUTER_UNAVAILABLE =
  'The user\'s computer is not connected. If the task needs it, ask them to open the Rakazo desktop app and turn on "Let bots use this computer" in its settings.';

/**
 * Which runs besides the owner's own chat may reach their paired computer: their routines, chains
 * of their own bots that started where the computer was reachable (or, with `webhookChains`, at a
 * webhook, Git event or email their routine received), and their own messages from a chat app they
 * linked. Server switches USER_DEVICES_ALLOW_ROUTINES, USER_DEVICES_ALLOW_OWN_BOTS,
 * USER_DEVICES_ALLOW_MESSAGING and USER_DEVICES_ALLOW_WEBHOOK_CHAINS, all off by default.
 */
export type UserComputerAccess = {
  routines: boolean;
  ownBots: boolean;
  messaging: boolean;
  webhookChains: boolean;
  /** Chat apps whose platform vouches for each sender; only their linked messages count. */
  verifiedChatApps?: readonly string[];
  /** A routine run keeps the computer without asking again after it read outside content. */
  routinesAfterOutsideContent?: boolean;
};

export const NO_USER_COMPUTER_ACCESS: UserComputerAccess = {
  routines: false,
  ownBots: false,
  messaging: false,
  webhookChains: false,
};

/**
 * Whose own computer this run may reach: the bot owner's, when their own message started it or it
 * is one of their routines they let use it (see routineRunUsesOwnerComputer). With the server's
 * switches on, also their own bot's scheduled routine, their own message from a chat app they
 * linked (`ownerMessage`, see ownerDirectMessage), and a message from another of their bots when
 * `ownBotChain` says the chain behind it started with them (see botChainFromOwner), none in a group
 * chat. A routine that watches something hands the run text someone else may have written, so it
 * reaches no one's through the switch; nor do webhooks, channels, helpers and other people's
 * messages.
 */
export function userComputerOwner(input: {
  trigger: string;
  sourceRole: string | undefined;
  messagingChannelRun: boolean;
  runUserId: string;
  botUserId: string;
  access: UserComputerAccess;
  ownBotChain: boolean;
  groupThread: boolean;
  /** The run's routine watches something, or is gone. */
  routineWatches: boolean;
  /** A chat-app run's source is the owner's own message from their linked chat app. */
  ownerMessage: boolean;
  /** The owner turned on "Use my computer" for this routine, and its run still qualifies. */
  ownerComputerRoutine: boolean;
  /** A helper the run was delegated to, judged by `trigger`, its origin's; no switch reaches it. */
  helperRun: boolean;
}): string | undefined {
  if (input.messagingChannelRun || input.runUserId !== input.botUserId) return undefined;
  const reachable =
    input.trigger === "user" || input.trigger === "follow_up"
      ? input.sourceRole === "user"
      : (input.trigger === "routine" && input.ownerComputerRoutine) ||
        (!input.groupThread &&
          !input.helperRun &&
          (input.trigger === "routine"
            ? input.access.routines && !input.routineWatches
            : input.trigger === "messaging"
              ? input.access.messaging && input.ownerMessage
              : input.trigger === "bot_message" && input.access.ownBots && input.ownBotChain));
  return reachable ? input.runUserId : undefined;
}

/**
 * Whether a routine run is only its routine's own prompt: the routine still exists and watches
 * nothing, and the task quotes no watch. A task queued while its routine watched keeps the note
 * after the watch is removed, and a retry copies it.
 */
function scheduledRoutine(run: {
  task: { prompt: string };
  routine: { watch: unknown } | null;
}): boolean {
  return (
    run.routine !== null &&
    run.routine.watch === null &&
    !run.task.prompt.includes(ROUTINE_WATCH_NOTE_START)
  );
}

/** Whether a routine run may carry text its routine watched for, or no longer has a routine. */
export async function routineRunWatches(prisma: PrismaClient, runId: string): Promise<boolean> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { task: { select: { prompt: true } }, routine: { select: { watch: true } } },
  });
  return !run || !scheduledRoutine(run);
}

/**
 * Whether a chat-app run's source is the owner's own message from the chat app they linked to this
 * bot: in the run's own thread, written by them, outside a group or team chat. The link proves the
 * sender: a 1:1 chat-app message reaches a bot only from the address bound to it by a code its
 * owner made while signed in.
 */
export async function ownerDirectMessage(
  prisma: PrismaClient,
  run: { userId: string; botId: string; threadId: string; sourceMessageId: string | null },
  access: UserComputerAccess,
): Promise<boolean> {
  if (!run.sourceMessageId) return false;
  const [source, link] = await Promise.all([
    prisma.message.findUnique({
      where: { id: run.sourceMessageId },
      select: {
        id: true,
        role: true,
        authorUserId: true,
        clientNonce: true,
        blocks: true,
        threadId: true,
        thread: { select: { groupId: true, externalConversationId: true } },
      },
    }),
    prisma.messagingIdentity.findUnique({
      where: { botId: run.botId },
      select: { provider: true, userId: true },
    }),
  ]);
  return Boolean(
    source &&
      link &&
      link.userId === run.userId &&
      access.verifiedChatApps?.includes(link.provider) &&
      source.threadId === run.threadId &&
      source.role === "user" &&
      source.authorUserId === run.userId &&
      !source.thread.groupId &&
      !source.thread.externalConversationId &&
      source.clientNonce?.startsWith(messagingMessageClientNonce(link.provider, "")) &&
      !mayBeChannelMessage(source),
  );
}

/**
 * The stored facts userComputerOwner needs about a run started by something other than the owner's
 * own chat, each read only when its switch is on and the owner owns the bot.
 */
export async function userComputerTrust(
  prisma: PrismaClient,
  run: {
    id: string;
    trigger: string;
    userId: string;
    spaceId: string;
    botId: string;
    threadId: string;
    sourceMessageId: string | null;
  },
  ownsBot: boolean,
  access: UserComputerAccess,
): Promise<{ ownBotChain: boolean; routineWatches: boolean; ownerMessage: boolean }> {
  return {
    ownBotChain:
      run.trigger === "bot_message" &&
      access.ownBots &&
      ownsBot &&
      (await botChainFromOwner(prisma, run, access)),
    routineWatches:
      run.trigger === "routine" && access.routines && (await routineRunWatches(prisma, run.id)),
    ownerMessage:
      run.trigger === "messaging" &&
      access.messaging &&
      ownsBot &&
      (await ownerDirectMessage(prisma, run, access)),
  };
}

/**
 * Outside tasks whose text, once handed into a run, keeps it from the owner's computer. A webhook,
 * Git event or email always does: the bot that took one in never gets the computer, and only the
 * bots it messages may (see botChainFromOwner).
 */
export function userComputerBlockingOrigins(access: UserComputerAccess): string[] {
  return [...(access.routines ? [] : ["routine"]), "webhook"];
}

/** Whether a stored message is a webhook, Git event or email delivery a routine received. */
function markedDelivery(message: { id: string; role: string; blocks: unknown } | null): boolean {
  if (message?.role !== "user") return false;
  const read = readMessageBlocks(message);
  return (
    read.intact &&
    read.blocks.some((block) => block.kind === "delivery" && block.outsideEvent === true)
  );
}

/**
 * Whether a webhook-triggered run took in only webhook, Git event or email deliveries its bot's
 * routine received, as each delivery marked it: its source, in its own thread, and every delivery
 * held while the bot was busy and handed to it in the same batch. A chat-app wake is not marked.
 */
async function outsideEventDelivery(
  prisma: PrismaClient,
  run: { id: string; threadId: string; sourceMessageId: string | null },
): Promise<boolean> {
  if (!run.sourceMessageId) return false;
  const [source, batch] = await Promise.all([
    prisma.message.findUnique({
      where: { id: run.sourceMessageId },
      select: { id: true, role: true, blocks: true, threadId: true },
    }),
    prisma.steeringMessage.findMany({
      where: { runId: run.id, originTrigger: "webhook" },
      select: { message: { select: { id: true, role: true, blocks: true } } },
    }),
  ]);
  return (
    source?.threadId === run.threadId &&
    markedDelivery(source) &&
    batch.every((item) => markedDelivery(item.message))
  );
}

/**
 * Whether the bot message that started a run comes from a chain the owner started: each sender run
 * is theirs, in this Space, on one of their bots, outside a group chat, took in no blocked outside
 * task, and the first one started where their computer is reachable (their own message, or a
 * scheduled routine, their own linked chat-app message, or a webhook, Git event or email their
 * routine received, when allowed). The caller checks that the receiving run is the owner's own. A
 * link that is missing, unreadable or past the hop limit refuses.
 */
export async function botChainFromOwner(
  prisma: PrismaClient,
  run: { userId: string; spaceId: string; botId: string; sourceMessageId: string | null },
  access: UserComputerAccess,
  maxHops = BOT_MESSAGE_MAX_HOPS,
): Promise<boolean> {
  let messageId = run.sourceMessageId;
  for (let hop = 0; hop < maxHops && messageId; hop++) {
    const inbound = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, blocks: true },
    });
    if (!inbound) return false;
    const read = readMessageBlocks(inbound);
    const received = read.blocks.find((block) => block.kind === "bot_message_received");
    // Stored fields are not checked against today's schema, so check the one this reads.
    const returnTo =
      received?.kind === "bot_message_received" ? (received.returnToMessageId as unknown) : null;
    if (!read.intact || typeof returnTo !== "string" || !returnTo) return false;
    const outbound = await prisma.message.findUnique({
      where: { id: returnTo },
      select: { runId: true },
    });
    if (!outbound?.runId) return false;
    const findSender = (id: string) =>
      prisma.run.findUnique({
        where: { id },
        select: {
          id: true,
          trigger: true,
          userId: true,
          spaceId: true,
          botId: true,
          threadId: true,
          delegatedFromRunId: true,
          sourceMessageId: true,
          bot: { select: { userId: true } },
          thread: { select: { groupId: true } },
          routine: { select: { watch: true } },
          task: { select: { prompt: true } },
        },
      });
    const ownSender = (sender: Awaited<ReturnType<typeof findSender>>) =>
      sender !== null &&
      sender.userId === run.userId &&
      sender.spaceId === run.spaceId &&
      sender.bot.userId === run.userId &&
      !sender.thread.groupId;
    // Outside events handed into a sender count only as one that may start a chain: allowed,
    // each marked, and never on their way back to the bot that took them in.
    const steeredIn = async (sender: { id: string; botId: string }) => {
      const [routineText, events] = await Promise.all([
        access.routines
          ? null
          : prisma.steeringMessage.findFirst({
              where: {
                runId: sender.id,
                claimedAt: { not: null },
                originTrigger: { in: ["routine"] },
              },
              select: { id: true },
            }),
        prisma.steeringMessage.findMany({
          where: { runId: sender.id, claimedAt: { not: null }, originTrigger: "webhook" },
          select: { message: { select: { id: true, role: true, blocks: true } } },
        }),
      ]);
      return (
        Boolean(routineText) ||
        (events.length > 0 &&
          !(
            access.webhookChains &&
            sender.botId !== run.botId &&
            events.every((item) => markedDelivery(item.message))
          ))
      );
    };
    let sender = await findSender(outbound.runId);
    // A run that picks up a helper's result goes on with the conversation that started the
    // helper, so the chain goes on from that conversation, and text handed into either counts.
    if (sender?.trigger === HELPER_RESULT_TRIGGER) {
      if (!ownSender(sender) || (await steeredIn(sender))) return false;
      const origin = await loadRunOrigin(prisma, sender);
      sender = origin ? await findSender(origin.id) : null;
    }
    if (!sender || !ownSender(sender) || (await steeredIn(sender))) return false;
    if (sender.trigger === "routine") return access.routines && scheduledRoutine(sender);
    if (sender.trigger === "messaging")
      return access.messaging && (await ownerDirectMessage(prisma, sender, access));
    // The bot that took in the event stays off the computer, even when work comes back to it.
    if (sender.trigger === "webhook")
      return (
        access.webhookChains &&
        sender.botId !== run.botId &&
        (await outsideEventDelivery(prisma, sender))
      );
    if (sender.trigger === "user" || sender.trigger === "follow_up") {
      const source = sender.sourceMessageId
        ? await prisma.message.findUnique({
            where: { id: sender.sourceMessageId },
            select: { id: true, role: true, blocks: true },
          })
        : null;
      return source?.role === "user" && !mayBeChannelMessage(source);
    }
    if (sender.trigger !== "bot_message") return false;
    messageId = sender.sourceMessageId;
  }
  return false;
}

/**
 * The user's own computer asks a person first in Ask and Auto, whatever the rules allow, until they
 * choose "Allow in this space"; Never ask runs it, since pairing was consent, and a block refuses it. These tools run
 * only in the user's own runs (see userComputerOwner), so any effect of them past "intended" in
 * this space traces back to that approval. Removing every paired computer ends it, so pairing again
 * asks again. Screen control is approved per app. A routine runs unattended, so once it has read
 * outside content, such as a fetched page, every call asks again whatever the mode or earlier
 * approvals, unless the server lets routines go on after outside content. The owner's own
 * computer output does not count, so a routine can take several steps.
 */
export async function userComputerGate(
  ctx: RunContext,
  blocked: boolean,
  name: string,
  args: Record<string, unknown>,
  mode: ApprovalMode,
): Promise<"deny" | "allow" | "ask"> {
  if (blocked) return "deny";
  if (
    ctx.run.trigger === "routine" &&
    !ctx.deps.userComputerAccess?.routinesAfterOutsideContent &&
    (await isRunTaintedBeyondOwnComputer(ctx))
  )
    return "ask";
  // Pairing the desktop was the owner's consent; Never ask does not ask again.
  if (mode === "never") return "allow";
  const { deps, run } = ctx;
  const pairedSince = await deps.userDevices?.pairedSince(run.userId);
  if (!pairedSince) return "ask";
  const where = {
    spaceId: run.spaceId,
    status: { in: ["approved", "executing", "completed", "uncertain"] },
    createdAt: { gte: pairedSince },
    run: { userId: run.userId },
  };
  if (!USER_COMPUTER_SCREEN_TOOLS.has(name)) {
    const allowed = await deps.prisma.externalEffect.findFirst({
      where: { ...where, kind: USER_COMPUTER_SHELL_TOOL },
      select: { id: true },
    });
    return allowed ? "allow" : "ask";
  }
  const app = userComputerAppName(args.app).toLowerCase();
  if (!app) return "ask";
  // Every screen action records an effect, so page through them rather than cap the search.
  let cursor: string | undefined;
  for (;;) {
    const page = await deps.prisma.externalEffect.findMany({
      where: { ...where, kind: { in: [...USER_COMPUTER_SCREEN_TOOLS] } },
      select: { id: true, request: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: SCREEN_APPROVAL_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (
      page.some(
        (effect) =>
          userComputerAppName((effect.request as { app?: unknown } | null)?.app).toLowerCase() ===
          app,
      )
    )
      return "allow";
    if (page.length < SCREEN_APPROVAL_PAGE) return "ask";
    cursor = page.at(-1)!.id;
  }
}

const SCREEN_APPROVAL_PAGE = 200;

/** The working directory on the user's computer: their home or a folder inside it. */
export function userComputerCwd(environment: HostComputerEnvironment, cwd: unknown): string {
  const paths = environment.platform === "win32" ? path.win32 : path.posix;
  const requested = typeof cwd === "string" ? cwd.trim() : "";
  if (!requested || requested === "~") return environment.home;
  const expanded = /^~[\\/]/.test(requested)
    ? paths.join(environment.home, requested.slice(2))
    : requested;
  const resolved = paths.resolve(environment.home, expanded);
  const relative = paths.relative(environment.home, resolved);
  if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))
    throw new Error("cwd must be inside the user's home folder; cd elsewhere within the command");
  return resolved;
}

async function lastValue<T>(values: AsyncIterable<T>): Promise<T> {
  let result: { value: T } | undefined;
  for await (const value of values) result = { value };
  if (!result) throw new Error("no response");
  return result.value;
}

/** Checked again at execution: the desktop can disconnect or be revoked after the offer. */
async function connectedUserComputer(ctx: RunContext, computerId?: string) {
  const owner = ctx.source.userComputerOwner;
  const devices = ctx.deps.userDevices;
  const device =
    owner && devices ? await devices.connected(owner, computerId).catch(() => null) : null;
  return owner && devices && device ? { owner, devices, deviceId: device.deviceId } : undefined;
}

const TARGET_UNAVAILABLE =
  "The selected computer is disconnected or not allowed for this user. Use user_computer_list to see available computers.";

function requestedComputer(args: Record<string, unknown>): { computerId?: string; error?: string } {
  if (args.computerId === undefined) return {};
  if (typeof args.computerId !== "string" || !args.computerId.trim() || args.computerId.length > 64)
    return { error: "computerId must be a non-empty computer id from user_computer_list." };
  return { computerId: args.computerId };
}

export async function userComputerList(ctx: RunContext, call: ToolCall) {
  const owner = ctx.source.userComputerOwner;
  const devices = ctx.deps.userDevices;
  if (!owner || !devices) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
  const computers = (await devices.list(owner))
    .filter((device) => device.connected)
    .map((device) => ({
      computerId: device.deviceId,
      name: device.name,
      bound: device.bound === true,
    }));
  return call.finish({ computers });
}

export async function userComputerShell(ctx: RunContext, call: ToolCall) {
  const { bot, runId } = ctx;
  const target = requestedComputer(call.args);
  if (target.error) return call.finish({ error: target.error });
  const connected = await connectedUserComputer(ctx, target.computerId);
  if (!connected)
    return call.finish({
      error: target.computerId ? TARGET_UNAVAILABLE : USER_COMPUTER_UNAVAILABLE,
    });
  const { owner, devices, deviceId } = connected;
  const { signal } = ctx.context;
  const command = String(call.args.command ?? "");
  try {
    // The device only executes for a provisioned bot; provisioning is idempotent.
    await lastValue(
      devices.request(owner, { method: "provision", botId: bot.id, runId }, signal, deviceId),
    );
    const environment = await lastValue(
      devices.request<HostComputerEnvironment>(
        owner,
        { method: "environment", botId: bot.id, runId },
        signal,
        deviceId,
      ),
    );
    const observed = await observeShellCommand(
      devices.request<ProcessEvent>(
        owner,
        {
          method: "execute",
          botId: bot.id,
          runId,
          command: {
            argv: nativeShellCommandArgv(command, environment),
            cwd: userComputerCwd(environment, call.args.cwd),
            timeoutMs: sandboxCommandTimeoutMs(),
          },
        },
        signal,
        deviceId,
      ),
      { secrets: ctx.secrets },
    );
    if (!observed.completion) return call.finish(observed.result);
    void observed.completion.catch(() => undefined);
    const returned = await call.finish({ ...observed.result, notice: SHELL_STILL_RUNNING_NOTICE });
    if (isRunningShellCommand(returned)) call.observer?.onShellStillRunning?.(observed.completion);
    return returned;
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(
      error instanceof Error ? error.message : "command failed",
      ctx.secrets,
    );
    return call.finish({ error: `The user's computer did not finish the command: ${reason}` });
  }
}

const screenActions = z.array(hostScreenAction).min(1).max(HOST_SCREEN_MAX_ACTIONS);

export function userComputerObserve(ctx: RunContext, call: ToolCall) {
  const query = typeof call.args.query === "string" ? call.args.query.trim() : "";
  return userComputerScreen(ctx, call, {
    method: "screenObserve",
    app: userComputerAppName(call.args.app),
    ...(query ? { query } : {}),
  });
}

export function userComputerAct(ctx: RunContext, call: ToolCall) {
  const actions = screenActions.safeParse(call.args.actions);
  if (!actions.success) {
    const issue = actions.error.issues[0];
    const where = issue?.path.length ? `actions.${issue.path.join(".")}: ` : "actions: ";
    return call.finish({ error: `${where}${issue?.message ?? "invalid"}` });
  }
  return userComputerScreen(ctx, call, {
    method: "screenAct",
    app: userComputerAppName(call.args.app),
    actions: actions.data,
  });
}

type ScreenRequest =
  | { method: "screenObserve"; app: string; query?: string }
  | { method: "screenAct"; app: string; actions: HostScreenAction[] };

/** The device gets the app name the approval card showed, never the raw argument. */
async function userComputerScreen(ctx: RunContext, call: ToolCall, request: ScreenRequest) {
  if (!request.app) return call.finish({ error: "app must name an app on the user's computer." });
  const target = requestedComputer(call.args);
  if (target.error) return call.finish({ error: target.error });
  const connected = await connectedUserComputer(ctx, target.computerId);
  if (!connected)
    return call.finish({
      error: target.computerId ? TARGET_UNAVAILABLE : USER_COMPUTER_UNAVAILABLE,
    });
  const { owner, devices, deviceId } = connected;
  const { signal } = ctx.context;
  try {
    const value = await lastValue(
      devices.request<HostScreenObservation | HostScreenActResult>(
        owner,
        { ...request, botId: ctx.bot.id, runId: ctx.runId },
        signal,
        deviceId,
      ),
    );
    if (request.method === "screenObserve")
      return call.finish(screenToolResult(ctx, value as HostScreenObservation, "observed"));
    const acted = value as HostScreenActResult;
    const total = request.actions.length;
    const note = `completed ${acted.completed} of ${total} action${total === 1 ? "" : "s"}${
      acted.error ? `; stopped: ${redactSecrets(acted.error, ctx.secrets)}` : ""
    }`;
    return call.finish(
      acted.observation
        ? screenToolResult(ctx, acted.observation, note)
        : { completed: acted.completed, ...(acted.error ? { error: note } : {}) },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(
      error instanceof Error ? error.message : "screen control failed",
      ctx.secrets,
    );
    return call.finish({ error: `The user's computer did not finish: ${reason}` });
  }
}

/** Only the window's name and size are stored; the rows and screenshot reach the model alone. */
function screenToolResult(
  ctx: RunContext,
  observation: HostScreenObservation,
  note: string,
): AgentToolExecutionResult {
  const image = ctx.computer.acceptsImages ? observation.image : undefined;
  const details = {
    app: observation.app,
    ...(observation.title ? { title: redactSecrets(observation.title, ctx.secrets) } : {}),
    ...(image ? { width: image.width, height: image.height } : {}),
  };
  return {
    kind: "agent_tool_result",
    content: [
      {
        type: "text",
        text: `${note}\n${JSON.stringify(details)}\n${redactSecrets(observation.tree, ctx.secrets)}`,
      },
      ...(image ? [{ type: "image" as const, data: image.data, mimeType: image.mimeType }] : []),
    ],
    details,
  };
}
