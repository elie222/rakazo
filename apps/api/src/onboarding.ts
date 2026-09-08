import type { ConnectorRegistry } from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { featuredConnectorProvidersMatch } from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  type Prisma,
  type PrismaClient,
  type ThreadEvents,
} from "@rakazo/db";

/**
 * First-run conversational onboarding, seeded deterministically into the bot's
 * thread: greeting, a focus choice, and available app cards the user authorizes
 * inline. Focus must not rename the bot. No model tokens are spent.
 */

type OnboardingDeps = {
  prisma: PrismaClient;
  events: ThreadEvents;
  connectors: ConnectorRegistry;
};

type FocusOption = {
  id: string;
  letter: string;
  label: string;
  summary: string;
  apps: string[];
};

const FOCUS_OPTIONS: FocusOption[] = [
  {
    id: "day",
    letter: "A",
    label: "Day-to-day work",
    summary: "Slack, calendar, and email",
    apps: ["slack", "gmail", "googlecalendar"],
  },
  {
    id: "inbox",
    letter: "B",
    label: "Inbox & email",
    summary: "email and calendar",
    apps: ["gmail", "googlecalendar", "slack"],
  },
  {
    id: "research",
    letter: "C",
    label: "Research & writing",
    summary: "the web, notes, and docs",
    apps: ["hackernews", "notion", "googledocs"],
  },
  {
    id: "everything",
    letter: "D",
    label: "A bit of everything",
    summary: "Slack, calendar, and email",
    apps: ["slack", "gmail", "googlecalendar"],
  },
];

const APP_DESCRIPTIONS: Record<string, string> = {
  slack: "Search, read, and send messages.",
  gmail: "Search, read, draft, and send email.",
  googlecalendar: "Search events and schedule meetings.",
  notion: "Search and edit pages and databases.",
  googledocs: "Draft and edit documents.",
  hackernews: "Search stories and discussions.",
};

async function requireBotThread(deps: OnboardingDeps, actor: Actor, botId: string) {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    include: { thread: true },
  });
  if (!bot?.thread) throw new IsolationError();
  return { bot, thread: bot.thread };
}

async function post(
  deps: OnboardingDeps,
  target: { spaceId: string; botId: string; threadId: string },
  blocks: MessageBlock[],
): Promise<string> {
  const committed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const message = await createThreadMessageInTransaction(tx, {
      threadId: target.threadId,
      role: "bot",
      blocks,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { message, event };
  });
  await deps.events.notify(target.threadId, committed.event.seq);
  return committed.message.id;
}

async function updateBlocks(
  deps: OnboardingDeps,
  target: { spaceId: string; botId: string; threadId: string },
  messageId: string,
  blocks: MessageBlock[],
): Promise<void> {
  const event = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.message.update({ where: { id: messageId }, data: { blocks } });
    return appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.updated",
      payload: { messageId, role: "bot", blocks },
    });
  });
  await deps.events.notify(target.threadId, event.seq);
}

/** Sentinel answerId for a focus card the user dismissed without choosing. */
export const FOCUS_DISMISSED_ANSWER_ID = "_dismissed";

export async function startOnboarding(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const { thread } = await requireBotThread(deps, actor, botId);
  const existing = await deps.prisma.message.count({ where: { threadId: thread.id } });
  if (existing > 0) return;
  // Fresh chats start empty (same as web). The focus card is posted later via
  // promptFocus so non-first bots can wait ~10s for free typing, or skip if the
  // user already engaged.
}

function messageHasChoice(blocks: MessageBlock[]): boolean {
  return blocks.some((block) => block.kind === "choice");
}

function messageHasPendingChoice(blocks: MessageBlock[]): boolean {
  return blocks.some((block) => block.kind === "choice" && !block.answerId);
}

export async function promptFocus(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = { spaceId: actor.spaceId, botId: bot.id, threadId: thread.id };
  const blocks: MessageBlock[] = [
    {
      kind: "choice",
      question: "What do you want me on first?",
      options: FOCUS_OPTIONS.map(({ id, letter, label }) => ({ id, letter, label })),
    },
  ];
  // Check + insert + event in one transaction so concurrent promptFocus calls
  // cannot duplicate cards, and a concurrent user send cannot publish first.
  const committed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Serialize concurrent promptFocus callers on this thread before the gate check.
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    const recent = await tx.message.findMany({
      where: { threadId: thread.id },
      select: { role: true, blocks: true },
      orderBy: { createdAt: "asc" },
    });
    if (recent.some((message) => message.role === "user")) return null;
    if (recent.some((message) => messageHasChoice(message.blocks as MessageBlock[]))) return null;
    const message = await createThreadMessageInTransaction(tx, {
      threadId: target.threadId,
      role: "bot",
      blocks,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { message, event };
  });
  if (!committed) return;
  await deps.events.notify(target.threadId, committed.event.seq);
}

export async function dismissFocus(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = { spaceId: actor.spaceId, botId: bot.id, threadId: thread.id };
  const claimed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    const recent = await tx.message.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: "asc" },
    });
    const pending = recent.find((message) =>
      messageHasPendingChoice(message.blocks as MessageBlock[]),
    );
    if (!pending) return null;
    const blocks = (pending.blocks as MessageBlock[]).map((block) =>
      block.kind === "choice" && !block.answerId
        ? { ...block, answerId: FOCUS_DISMISSED_ANSWER_ID }
        : block,
    );
    await tx.message.update({ where: { id: pending.id }, data: { blocks } });
    const event = await appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.updated",
      payload: { messageId: pending.id, role: "bot", blocks },
    });
    return { messageId: pending.id, blocks, event };
  });
  if (!claimed) return;
  await deps.events.notify(target.threadId, claimed.event.seq);
}

export async function chooseFocus(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
  optionId: string,
): Promise<void> {
  const option = FOCUS_OPTIONS.find((entry) => entry.id === optionId);
  if (!option) throw new IsolationError();
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = { spaceId: actor.spaceId, botId: bot.id, threadId: thread.id };

  const claimed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    const recent = await tx.message.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: "asc" },
    });
    const pending = recent.find((message) =>
      messageHasPendingChoice(message.blocks as MessageBlock[]),
    );
    if (!pending) return null;
    const blocks = (pending.blocks as MessageBlock[]).map((block) =>
      block.kind === "choice" ? { ...block, answerId: option.id } : block,
    );
    await tx.message.update({ where: { id: pending.id }, data: { blocks } });
    const event = await appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.updated",
      payload: { messageId: pending.id, role: "bot", blocks },
    });
    return { messageId: pending.id, blocks, event };
  });
  if (!claimed) return;
  await deps.events.notify(target.threadId, claimed.event.seq);

  // Keep the name and title the user chose when creating the bot; the focus
  // step only suggests apps, it must not rename the bot.
  await post(deps, target, [
    {
      kind: "text",
      text: `Got it. ${capitalize(option.summary)}. I’ll see what’s already connected so I don’t make you set something up twice.`,
    },
  ]);

  const providers = deps.connectors.managedProviders();
  const catalog = (
    await Promise.all(
      providers.map((provider) =>
        provider
          .catalog({
            operationId: "onboarding.choose",
            traceId: "onboarding.choose",
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: bot.id,
            signal: AbortSignal.timeout(15_000),
          })
          .catch(() => []),
      ),
    )
  ).flat();
  const cards: MessageBlock[] = option.apps.flatMap((slug) => {
    const entry = catalog.find(
      (item) =>
        item.slug.toLowerCase() === slug.toLowerCase() ||
        featuredConnectorProvidersMatch(item.slug, slug),
    );
    if (!entry) return [];
    return [
      {
        kind: "app_connect" as const,
        connectorId: entry.connectorId ?? "composio",
        provider: entry.slug,
        name: entry.name,
        description: APP_DESCRIPTIONS[slug] ?? "",
        logo: entry.logo ?? null,
        status: entry.connected ? ("connected" as const) : ("pending" as const),
      },
    ];
  });
  if (!cards.length) {
    await post(deps, target, [{ kind: "text", text: "What would you like to work on first?" }]);
    return;
  }
  const cardNames = cards
    .map((card) => (card.kind === "app_connect" ? card.name : ""))
    .filter(Boolean);
  const named = `${cardNames.slice(0, -1).join(", ")}${cardNames.length > 1 ? ", and " : ""}${cardNames.at(-1)}`;
  await post(deps, target, [
    {
      kind: "text",
      text: `${named} are a good place to start. Connect them here and I’ll use what you already have.`,
    },
  ]);
  await post(deps, target, cards);
  await post(deps, target, [
    {
      kind: "text",
      text: `Hit those ${cards.length === 1 ? "one" : cards.length === 2 ? "two" : "three"} and I’ll start pulling the picture.`,
    },
  ]);
}

export async function markAppConnected(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
  provider: string,
  connectorId = "composio",
): Promise<void> {
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = { spaceId: actor.spaceId, botId: bot.id, threadId: thread.id };
  const messages = await deps.prisma.message.findMany({
    where: { threadId: thread.id },
    select: { id: true, blocks: true },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  for (const message of messages) {
    const blocks = message.blocks as MessageBlock[];
    if (
      !blocks.some(
        (block) =>
          block.kind === "app_connect" &&
          (block.connectorId ?? "composio") === connectorId &&
          featuredConnectorProvidersMatch(block.provider, provider) &&
          block.status !== "connected",
      )
    )
      continue;
    const next = blocks.map((block) =>
      block.kind === "app_connect" &&
      (block.connectorId ?? "composio") === connectorId &&
      featuredConnectorProvidersMatch(block.provider, provider)
        ? { ...block, status: "connected" as const }
        : block,
    );
    await updateBlocks(deps, target, message.id, next);
  }
}

function capitalize(value: string): string {
  return value.length > 0 ? (value[0] ?? "").toUpperCase() + value.slice(1) : value;
}
