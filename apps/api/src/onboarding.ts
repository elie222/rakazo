import type { ComposioProvider } from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { featuredConnectorProvidersMatch } from "@rakazo/core";
import {
  createThreadMessage,
  IsolationError,
  type PrismaClient,
  type ThreadEvents,
} from "@rakazo/db";

/**
 * First-run conversational onboarding, seeded deterministically into the bot's
 * thread: greeting, a focus choice, and Composio app cards the user authorizes
 * inline. Focus must not rename the bot. No model tokens are spent.
 */

type OnboardingDeps = {
  prisma: PrismaClient;
  events: ThreadEvents;
  composio?: Pick<ComposioProvider, "catalog">;
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

const APP_NAMES: Record<string, string> = {
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  googledocs: "Google Docs",
  hackernews: "Hacker News",
  notion: "Notion",
  slack: "Slack",
};

async function requireBotThread(deps: OnboardingDeps, actor: Actor, botId: string) {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, workspaceId: actor.workspaceId, userId: actor.userId },
    include: { thread: true },
  });
  if (!bot?.thread) throw new IsolationError();
  return { bot, thread: bot.thread };
}

async function post(
  deps: OnboardingDeps,
  target: { workspaceId: string; botId: string; threadId: string },
  blocks: MessageBlock[],
): Promise<string> {
  const message = await createThreadMessage(deps.prisma, {
    threadId: target.threadId,
    role: "bot",
    blocks,
  });
  await deps.events.append({
    workspaceId: target.workspaceId,
    threadId: target.threadId,
    botId: target.botId,
    type: "thread.message.created",
    payload: { messageId: message.id, role: "bot", blocks },
  });
  return message.id;
}

async function updateBlocks(
  deps: OnboardingDeps,
  target: { workspaceId: string; botId: string; threadId: string },
  messageId: string,
  blocks: MessageBlock[],
): Promise<void> {
  await deps.prisma.message.update({ where: { id: messageId }, data: { blocks } });
  await deps.events.append({
    workspaceId: target.workspaceId,
    threadId: target.threadId,
    botId: target.botId,
    type: "thread.message.updated",
    payload: { messageId, role: "bot", blocks },
  });
}

export async function startOnboarding(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const existing = await deps.prisma.message.count({ where: { threadId: thread.id } });
  if (existing > 0) return;
  const user = await deps.prisma.user.findUnique({
    where: { id: actor.userId },
    select: { name: true },
  });
  const firstName = (user?.name ?? "there").split(/\s+/)[0];
  const target = { workspaceId: actor.workspaceId, botId: bot.id, threadId: thread.id };
  await post(deps, target, [
    { kind: "text", text: `Hey ${firstName}. Fresh start on my side, so I’ll keep this short.` },
  ]);
  await post(deps, target, [
    {
      kind: "choice",
      question: "What do you want me on first?",
      options: FOCUS_OPTIONS.map(({ id, letter, label }) => ({ id, letter, label })),
    },
  ]);
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
  const target = { workspaceId: actor.workspaceId, botId: bot.id, threadId: thread.id };

  const recent = await deps.prisma.message.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: "asc" },
  });
  const pending = recent.find((message) =>
    (message.blocks as MessageBlock[]).some((block) => block.kind === "choice" && !block.answerId),
  );
  if (!pending) return;
  const blocks = (pending.blocks as MessageBlock[]).map((block) =>
    block.kind === "choice" ? { ...block, answerId: option.id } : block,
  );
  await updateBlocks(deps, target, pending.id, blocks);

  // Keep the name and title the user chose when creating the bot; the focus
  // step only suggests apps, it must not rename the bot.
  await post(deps, target, [
    {
      kind: "text",
      text: `Got it. ${capitalize(option.summary)}. I’ll see what’s already connected so I don’t make you set something up twice.`,
    },
  ]);

  const catalog = deps.composio
    ? await deps.composio
        .catalog({
          operationId: "onboarding.choose",
          traceId: "onboarding.choose",
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          botId: bot.id,
          signal: new AbortController().signal,
        })
        .catch(() => [])
    : [];
  const bySlug = new Map(catalog.map((entry) => [entry.slug.toLowerCase(), entry]));
  const cards: MessageBlock[] = option.apps.map((slug) => {
    const entry = bySlug.get(slug.toLowerCase());
    return {
      kind: "app_connect",
      provider: entry?.slug ?? slug,
      name: entry?.name ?? APP_NAMES[slug] ?? capitalize(slug),
      description: APP_DESCRIPTIONS[slug] ?? `Connect ${entry?.name ?? slug} to your account.`,
      logo: entry?.logo ?? null,
      status: entry?.connected ? "connected" : "pending",
    };
  });
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
): Promise<void> {
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = { workspaceId: actor.workspaceId, botId: bot.id, threadId: thread.id };
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
          featuredConnectorProvidersMatch(block.provider, provider) &&
          block.status !== "connected",
      )
    )
      continue;
    const next = blocks.map((block) =>
      block.kind === "app_connect" && featuredConnectorProvidersMatch(block.provider, provider)
        ? { ...block, status: "connected" as const }
        : block,
    );
    await updateBlocks(deps, target, message.id, next);
  }
}

function capitalize(value: string): string {
  return value.length > 0 ? (value[0] ?? "").toUpperCase() + value.slice(1) : value;
}
