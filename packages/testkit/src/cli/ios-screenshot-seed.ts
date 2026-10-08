import { createDb, createThreadMessage } from "@rakazo/db";
import { sessionCookieHeader } from "../index.js";

const MARKER = "marigold checklist";
const READY = "The fixture workspace is ready.";
const GROUP_READY = "The fixture launch plan is ready.";
const FILE_NAME = "launch-notes.txt";

export interface IosScreenshotFixture {
  botId: string;
  groupId: string;
  routineId: string;
}

interface BotRow {
  id: string;
  name: string;
  threadId: string;
}

interface GroupRow {
  id: string;
  name: string;
  threadId: string;
}

interface RoutineRow {
  id: string;
  name: string;
  active: boolean;
}

interface MeRow {
  userId: string;
  spaceId: string;
}

export async function seedIosScreenshotFixture(input: {
  apiUrl: string;
  databaseUrl: string;
  email: string;
  emptyEmail: string;
  password: string;
}): Promise<IosScreenshotFixture> {
  const populated = await ensureUser(input.apiUrl, input.email, input.password, "Screenshot User");
  const empty = await ensureUser(input.apiUrl, input.emptyEmail, input.password, "Empty User");
  for (const bot of await rpc<BotRow[]>(input.apiUrl, empty.headers, "bots/list")) {
    await rpc(input.apiUrl, empty.headers, "bots/remove", { botId: bot.id, deleteMemories: false });
  }

  const bots = await rpc<BotRow[]>(input.apiUrl, populated.headers, "bots/list");
  const researcher = await ensureBot(input.apiUrl, populated.headers, bots, {
    name: "Researcher",
    title: "Product research",
    description: "Finds evidence and keeps fixture notes organized.",
  });
  const writer = await ensureBot(input.apiUrl, populated.headers, bots, {
    name: "Writer",
    title: "Clear writing",
    description: "Turns research into concise drafts.",
  });
  const support = await ensureBot(input.apiUrl, populated.headers, bots, {
    name: "Support",
    title: "Customer support",
    description: "Prepares friendly customer replies.",
  });
  const archived = await rpc<BotRow[]>(input.apiUrl, populated.headers, "bots/listArchived");
  if (!archived.some((bot) => bot.name === "Archived fixture")) {
    const created = await rpc<BotRow>(input.apiUrl, populated.headers, "bots/create", {
      name: "Archived fixture",
      title: "Archived",
      description: "A recoverable archived bot.",
      instructions: "Remain archived.",
      notifyOnFinish: true,
    });
    await rpc(input.apiUrl, populated.headers, "bots/archive", { botId: created.id });
  }

  const groups = await rpc<GroupRow[]>(input.apiUrl, populated.headers, "groups/list");
  let group = groups.find((item) => item.name === "Launch team");
  if (!group) {
    group = await rpc<GroupRow>(input.apiUrl, populated.headers, "groups/create", {
      name: "Launch team",
      botIds: [researcher.id, writer.id, support.id],
    });
  }
  const routines = await rpc<RoutineRow[]>(input.apiUrl, populated.headers, "routines/list", {
    botId: researcher.id,
  });
  let routine = routines.find((item) => item.name === "Weekly fixture review");
  if (!routine) {
    routine = await rpc<RoutineRow>(input.apiUrl, populated.headers, "routines/create", {
      botId: researcher.id,
      name: "Weekly fixture review",
      prompt: "Review the fixture launch notes and summarize the open questions.",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      active: false,
      notify: true,
    });
  }

  if (routine.active) {
    await rpc(input.apiUrl, populated.headers, "routines/update", {
      routineId: routine.id,
      active: false,
    });
  }

  const me = await rpc<MeRow>(input.apiUrl, populated.headers, "me");
  const db = createDb(input.databaseUrl, { applicationName: "ios-screenshots" });
  try {
    await ensureThreadCopy(db.prisma, {
      threadId: researcher.threadId,
      botId: researcher.id,
      spaceId: me.spaceId,
      userId: me.userId,
    });
    await ensureActivity(db.prisma, {
      threadId: researcher.threadId,
      botId: researcher.id,
      spaceId: me.spaceId,
      userId: me.userId,
    });
    await ensureText(db.prisma, group.threadId, "bot", writer.id, GROUP_READY);
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }

  return { botId: researcher.id, groupId: group.id, routineId: routine.id };
}

async function ensureBot(
  apiUrl: string,
  headers: Record<string, string>,
  bots: BotRow[],
  profile: { name: string; title: string; description: string },
) {
  const existing = bots.find((bot) => bot.name === profile.name);
  if (existing) return existing;
  return rpc<BotRow>(apiUrl, headers, "bots/create", {
    ...profile,
    instructions: profile.description,
    notifyOnFinish: true,
  });
}

async function ensureThreadCopy(
  prisma: ReturnType<typeof createDb>["prisma"],
  input: { threadId: string; botId: string; spaceId: string; userId: string },
) {
  const messages = await prisma.message.findMany({
    where: { threadId: input.threadId },
    select: { blocks: true },
  });
  const serialized = messages.map((message) => JSON.stringify(message.blocks));
  if (!serialized.some((blocks) => blocks.includes(READY))) {
    await createThreadMessage(prisma, {
      threadId: input.threadId,
      role: "user",
      blocks: [{ kind: "text", text: "Summarize the launch notes." }],
    });
    const artifact = await prisma.artifact.create({
      data: {
        spaceId: input.spaceId,
        userId: input.userId,
        botId: input.botId,
        name: FILE_NAME,
        mimeType: "text/plain",
        size: 2400,
        hash: "ios-screenshot-fixture",
        storageKey: `ios-screenshot-fixture/${input.botId}/${FILE_NAME}`,
      },
    });
    await createThreadMessage(prisma, {
      threadId: input.threadId,
      role: "bot",
      botId: input.botId,
      blocks: [
        {
          kind: "text",
          text: [
            READY,
            "",
            "**Checklist** with *italic* and `code`.",
            "",
            `The unique search phrase is ${MARKER}.`,
            "",
            "![Remote diagram](https://example.com/diagram.png)",
          ].join("\n"),
        },
        {
          kind: "file",
          artifactId: artifact.id,
          mimeType: "text/plain",
          name: FILE_NAME,
          size: 2400,
        },
      ],
    });
  }
}

async function ensureActivity(
  prisma: ReturnType<typeof createDb>["prisma"],
  input: { threadId: string; botId: string; spaceId: string; userId: string },
) {
  const existing = await prisma.run.findFirst({
    where: { threadId: input.threadId, status: "completed" },
    select: { id: true },
  });
  if (existing) return;
  const source = await prisma.message.findFirst({
    where: { threadId: input.threadId, role: "user" },
    select: { id: true },
  });
  const task = await prisma.task.create({
    data: {
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      threadId: input.threadId,
      prompt: "Prepare the fixture workspace",
      status: "completed",
    },
  });
  await prisma.run.create({
    data: {
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      threadId: input.threadId,
      taskId: task.id,
      status: "completed",
      trigger: "user",
      modelProvider: "scripted",
      modelId: "scripted",
      sourceMessageId: source?.id,
      startedAt: new Date(Date.now() - 2_000),
      completedAt: new Date(),
    },
  });
}

async function ensureText(
  prisma: ReturnType<typeof createDb>["prisma"],
  threadId: string,
  role: "user" | "bot",
  botId: string,
  text: string,
) {
  const messages = await prisma.message.findMany({
    where: { threadId },
    select: { blocks: true },
  });
  if (messages.some((message) => JSON.stringify(message.blocks).includes(text))) return;
  await createThreadMessage(prisma, {
    threadId,
    role,
    botId,
    blocks: [{ kind: "text", text }],
  });
}

async function ensureUser(apiUrl: string, email: string, password: string, name: string) {
  const signup = await postAuth(apiUrl, "sign-up", { email, password, name });
  const session = signup.ok ? signup : await postAuth(apiUrl, "sign-in", { email, password });
  if (!session.ok || !session.token) {
    throw new Error(
      `Could not sign in fixture user (${session.status})${session.message ? `: ${session.message}` : ""}`,
    );
  }
  return {
    headers: {
      authorization: `Bearer ${session.token}`,
      cookie: session.cookie,
      origin: "rakazo://",
    },
  };
}

async function postAuth(
  apiUrl: string,
  action: "sign-in" | "sign-up",
  body: { email: string; password: string; name?: string },
) {
  const response = await fetch(`${apiUrl}/api/auth/${action}/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "rakazo://" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const message =
    parsed &&
    typeof parsed === "object" &&
    "message" in parsed &&
    typeof parsed.message === "string"
      ? parsed.message
      : undefined;
  return {
    ok: response.ok,
    status: response.status,
    message,
    token: tokenFrom(response, parsed),
    cookie: sessionCookieHeader(response),
  };
}

function tokenFrom(response: Response, body: unknown) {
  if (body && typeof body === "object") {
    const record = body as { token?: unknown; session?: { token?: unknown } };
    if (typeof record.token === "string" && record.token) return record.token;
    if (typeof record.session?.token === "string" && record.session.token)
      return record.session.token;
  }
  const cookies = response.headers.get("set-cookie") ?? "";
  const encoded = cookies.match(/(?:^|,\s*)(?:__Secure-)?better-auth\.session_token=([^;,]*)/)?.[1];
  if (!encoded) return "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

async function rpc<T>(
  apiUrl: string,
  headers: Record<string, string>,
  procedure: string,
  body: unknown = {},
): Promise<T> {
  const response = await fetch(`${apiUrl}/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ json: body }),
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (!response.ok || parsed.error) {
    const message = parsed.error?.message ?? text.slice(0, 180);
    throw new Error(`${procedure} failed (${response.status}): ${message}`);
  }
  return parsed.json as T;
}
