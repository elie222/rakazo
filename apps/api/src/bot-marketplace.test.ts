import type { Actor, Bot, MarketplaceBot } from "@rakazo/contracts";
import {
  AgentImportCreateInput,
  isBotMarketplaceChanged,
  MarketplaceBotSchema,
  marketplaceBotIntro,
  marketplaceBotTemplate,
} from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AgentImportServices } from "./bots/agent-import.js";
import { requestDigest } from "./bots/agent-import.js";
import { createBotFromTemplateDefinition } from "./bots/bot-templates.js";
import { botMarketplaceRoutes } from "./routes/bot-marketplace.js";
import type { RouterContext } from "./routes/context.js";

const admin: Actor = {
  userId: "admin-1",
  spaceId: "space-1",
  email: "admin@example.test",
  isDeploymentOwner: false,
};
const member: Actor = { ...admin, userId: "user-1", email: "user@example.test" };

const listing = MarketplaceBotSchema.parse({
  id: "morning-briefing",
  version: 3,
  name: "Morning briefing",
  summary: "A weekday morning overview.",
  sample: "**Today**\n- 10:00 design review",
  description: "A scannable briefing every weekday morning.",
  instructions: "Summarise the day; never send without confirmation.",
  skills: [],
  routines: [{ name: "Briefing", prompt: "Summarise my day", crons: ["0 8 * * 1-5"] }],
  apps: [],
  author: { name: "Rakazo Team" },
  license: "Apache-2.0",
  category: "personal",
  tagline: "Your weekday morning overview.",
  outcomes: ["A scannable morning briefing."],
});

type Row = {
  slug: string;
  version: number;
  status: string;
  featured: boolean;
  sortOrder: number;
  listing: MarketplaceBot;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** An in-memory catalog plus the joins the handlers read; everything else finds nothing. */
function fakeDb() {
  const rows = new Map<string, Row>();
  const imports: {
    spaceId: string;
    userId: string;
    importKey: string;
    botId: string;
    source: string;
    bot: { archivedAt: Date | null };
  }[] = [];
  const users = [
    { id: "admin-1", email: "admin@example.test", emailVerified: true, timezone: "UTC" },
    { id: "user-1", email: "user@example.test", emailVerified: true, timezone: "UTC" },
  ];
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((user) => user.id === where.id) ?? null,
    },
    marketplaceBot: {
      findUnique: async ({ where }: { where: { slug: string } }) => rows.get(where.slug) ?? null,
      findFirst: async ({ where }: { where: { slug: string; status?: string } }) =>
        [...rows.values()].find(
          (row) => row.slug === where.slug && (!where.status || row.status === where.status),
        ) ?? null,
      findMany: async ({ where }: { where?: { status?: string } } = {}) =>
        [...rows.values()].filter((row) => !where?.status || row.status === where.status),
      create: async ({ data }: { data: Omit<Row, "createdAt" | "updatedAt" | "publishedAt"> }) => {
        const row: Row = {
          publishedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.set(row.slug, row);
        return row;
      },
      update: async ({ where, data }: { where: { slug: string }; data: Partial<Row> }) => {
        const row = rows.get(where.slug)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    agentImport: {
      findFirst: async () => null,
      findMany: async ({
        where,
      }: {
        where: { spaceId: string; userId: string; importKey: { in: string[] }; source: string };
      }) =>
        imports.filter(
          (row) =>
            row.spaceId === where.spaceId &&
            row.userId === where.userId &&
            row.source === where.source &&
            where.importKey.in.includes(row.importKey) &&
            row.bot.archivedAt === null,
        ),
    },
  };
  return { prisma, rows, imports };
}

/** The route file only uses authed.<path>.handler(fn); keep fn and drop the middleware. */
const passthrough: unknown = new Proxy(
  {},
  { get: (_target, prop) => (prop === "handler" ? (fn: unknown) => fn : passthrough) },
);

function routesWith(prisma: ReturnType<typeof fakeDb>["prisma"]) {
  const deps = { prisma, env: { adminEmails: ["admin@example.test"] } };
  const routes = botMarketplaceRoutes({
    deps,
    authed: passthrough,
    agentImportServices: { prisma },
  } as unknown as RouterContext);
  return routes.botMarketplace;
}

const call = (fn: unknown, actor: Actor, input: unknown) =>
  (fn as (args: { context: { actor: Actor }; input: unknown }) => Promise<unknown>)({
    context: { actor },
    input,
  });

describe("botMarketplace admin", () => {
  it("refuses non-admins", async () => {
    const { prisma } = fakeDb();
    const routes = routesWith(prisma);
    await expect(call(routes.admin.create, member, { listing })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("creates a draft at version one, whatever the editor sent", async () => {
    const { prisma, rows } = fakeDb();
    const routes = routesWith(prisma);
    const row = (await call(routes.admin.create, admin, { listing })) as Row;
    expect(row.status).toBe("draft");
    expect(row.version).toBe(1);
    expect(rows.get("morning-briefing")!.listing.version).toBe(1);
  });

  it("refuses a duplicate slug", async () => {
    const { prisma } = fakeDb();
    const routes = routesWith(prisma);
    await call(routes.admin.create, admin, { listing });
    await expect(call(routes.admin.create, admin, { listing })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("bumps the version on content changes only, and never renames the slug", async () => {
    const { prisma } = fakeDb();
    const routes = routesWith(prisma);
    await call(routes.admin.create, admin, { listing });
    const renamed = { ...listing, id: "other-bot", version: 1 };
    await expect(
      call(routes.admin.update, admin, { slug: "morning-briefing", listing: renamed }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const featured = (await call(routes.admin.update, admin, {
      slug: "morning-briefing",
      featured: true,
    })) as Row;
    expect(featured.version).toBe(1);
    expect(featured.featured).toBe(true);

    // Key order and the version field itself are not content.
    const reordered = JSON.parse(JSON.stringify(listing)) as MarketplaceBot;
    const same = (await call(routes.admin.update, admin, {
      slug: "morning-briefing",
      listing: { ...reordered, version: 1 },
    })) as Row;
    expect(same.version).toBe(1);

    const edited = (await call(routes.admin.update, admin, {
      slug: "morning-briefing",
      listing: { ...listing, version: 1, tagline: "A new promise." },
    })) as Row;
    expect(edited.version).toBe(2);
    expect(edited.listing.version).toBe(2);
  });

  it("publishes and unpublishes immediately", async () => {
    const { prisma } = fakeDb();
    const routes = routesWith(prisma);
    await call(routes.admin.create, admin, { listing });
    expect(((await call(routes.catalog, member, {})) as { entries: unknown[] }).entries).toEqual(
      [],
    );
    const published = (await call(routes.admin.setStatus, admin, {
      slug: "morning-briefing",
      status: "published",
    })) as Row;
    expect(published.publishedAt).not.toBeNull();
    expect(
      ((await call(routes.catalog, member, {})) as { entries: { slug: string }[] }).entries.map(
        (entry) => entry.slug,
      ),
    ).toEqual(["morning-briefing"]);
    await call(routes.admin.setStatus, admin, {
      slug: "morning-briefing",
      status: "unpublished",
    });
    await expect(call(routes.get, member, { slug: "morning-briefing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("botMarketplace catalog and get", () => {
  it("filters by query and category, and marks the installed bot", async () => {
    const { prisma, imports } = fakeDb();
    const routes = routesWith(prisma);
    await call(routes.admin.create, admin, { listing });
    await call(routes.admin.setStatus, admin, {
      slug: "morning-briefing",
      status: "published",
    });
    imports.push({
      spaceId: "space-1",
      userId: "user-1",
      importKey: "marketplace:morning-briefing",
      botId: "bot-1",
      source: "marketplace",
      bot: { archivedAt: null },
    });
    const catalog = (await call(routes.catalog, member, { query: "MORNING" })) as {
      entries: { slug: string; botId: string | null }[];
    };
    expect(catalog.entries).toEqual([
      expect.objectContaining({ slug: "morning-briefing", botId: "bot-1" }),
    ]);
    expect(
      ((await call(routes.catalog, member, { category: "engineering" })) as { entries: unknown[] })
        .entries,
    ).toEqual([]);
    expect(
      ((await call(routes.catalog, member, { query: "nothing" })) as { entries: unknown[] })
        .entries,
    ).toEqual([]);
    const got = (await call(routes.get, member, { slug: "morning-briefing" })) as {
      botId: string | null;
    };
    expect(got.botId).toBe("bot-1");
  });

  it("refuses an install from an older view", async () => {
    const { prisma } = fakeDb();
    const routes = routesWith(prisma);
    await call(routes.admin.create, admin, { listing });
    await call(routes.admin.setStatus, admin, {
      slug: "morning-briefing",
      status: "published",
    });
    const error = await call(routes.install, member, {
      slug: "morning-briefing",
      version: 99,
    }).catch((err: unknown) => err);
    expect(isBotMarketplaceChanged(error)).toBe(true);
  });
});

it("keeps marketplace import keys out of agent imports", () => {
  const request = {
    files: [{ path: "SOUL.md", content: "Calm." }],
    name: "Imported",
    selection: { instructions: [], memory: [], skills: [] },
  };
  expect(AgentImportCreateInput.safeParse({ ...request, importKey: "import-1234" }).success).toBe(
    true,
  );
  expect(
    AgentImportCreateInput.safeParse({ ...request, importKey: "marketplace:morning-briefing" })
      .success,
  ).toBe(false);
});

/**
 * A Prisma stand-in for the install transaction, as in agent-import.test.ts: writes echo
 * their data with an id; reads find nothing unless they are by id.
 */
function transactionalDb(): never {
  let next = 0;
  const rows = new Map<string, Record<string, unknown>>();
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get:
          (_, method: string) =>
          async (args?: { data?: Record<string, unknown>; where?: { id?: unknown } }) => {
            if (method === "findMany") return [];
            if (method === "findFirst" && typeof args?.where?.id === "string") {
              return rows.get(args.where.id) ?? null;
            }
            if (method.startsWith("find")) {
              return method === "findFirstOrThrow" ? { id: `${name}-thread` } : null;
            }
            next += 1;
            const row = {
              id: `${name}-${next}`,
              revision: 1,
              content: "",
              updatedAt: new Date(0),
              ...args?.data,
            };
            rows.set(row.id, row);
            return row;
          },
      },
    );
  return new Proxy(
    {},
    { get: (_, name: string) => (name.startsWith("$") ? async () => [] : model(name)) },
  ) as never;
}

describe("marketplace install semantics", () => {
  const bot = { id: "bot-1", threadId: "thread-1", name: "Morning briefing" } as Bot;

  function services(overrides: Partial<AgentImportServices>): AgentImportServices {
    const db = transactionalDb();
    return {
      prisma: db,
      createBot: async (_actor, input) => {
        await input.seed(db, bot.id);
        return bot;
      },
      hasModelConnection: async () => false,
      connectedProviders: async () => new Set(),
      mcpCredentialValues: async () => null,
      validateBotModel: async () => "Connect that model provider first",
      stdioAllowed: async () => () => false,
      prepareModelKey: async () => ({}),
      writeModelKey: async () => ({ id: "cred-1", secretId: "secret-1", provider: "openrouter" }),
      afterModelKey: () => undefined,
      prepareMcpServer: async () => null,
      insertMcpServer: async () => {
        throw new Error("not used");
      },
      findBot: async () => bot,
      assertRoutineSchedule: () => undefined,
      routineNextRunAt: () => null,
      routineRowData: (_actor, input) => ({ ...input }) as never,
      announceRoutine: async () => undefined,
      notifyThread: async () => undefined,
      ...overrides,
    } as AgentImportServices;
  }

  const options = {
    importKey: "marketplace:morning-briefing",
    source: "marketplace" as const,
    changedReason: "listing_changed",
    digest: { marketplaceSlug: "morning-briefing" },
  };

  it("records the marketplace source and key, with routines paused", async () => {
    const recorded: Record<string, unknown>[] = [];
    const routines: { active?: boolean }[] = [];
    const db = transactionalDb();
    const tx = new Proxy(db as object, {
      get: (target, prop) => {
        const base = target as {
          agentImport: {
            create: (args: unknown) => Promise<unknown>;
            deleteMany: (args: unknown) => Promise<unknown>;
          };
        };
        if (prop === "agentImport") {
          return {
            create: async (args: { data: Record<string, unknown> }) => {
              recorded.push(args.data);
              return base.agentImport.create(args);
            },
            deleteMany: (args: unknown) => base.agentImport.deleteMany(args),
          };
        }
        return (target as Record<string, unknown>)[prop as string];
      },
    });
    const result = await createBotFromTemplateDefinition(
      services({
        createBot: async (_actor, input) => {
          await input.seed(tx as never, bot.id);
          return bot;
        },
        routineRowData: (_actor, input) => {
          routines.push(input as { active?: boolean });
          return { ...input } as never;
        },
      }),
      async () => [],
      member,
      marketplaceBotTemplate(listing),
      { version: listing.version },
      options,
    );
    expect(result.created).toBe(true);
    expect(recorded).toEqual([
      expect.objectContaining({ source: "marketplace", importKey: "marketplace:morning-briefing" }),
    ]);
    expect(routines).toEqual([expect.objectContaining({ active: false })]);
  });

  it("posts the listing's intro and first question as the bot's first message", async () => {
    const messages: { blocks: { kind: string; text?: string }[] }[] = [];
    const db = transactionalDb();
    const tx = new Proxy(db as object, {
      get: (target, prop) =>
        prop === "message"
          ? {
              create: async (args: { data: { blocks: { kind: string; text?: string }[] } }) => {
                messages.push(args.data);
                return { id: `message-${messages.length}`, ...args.data };
              },
            }
          : (target as Record<string, unknown>)[prop as string],
    });
    const withIntro = MarketplaceBotSchema.parse({
      ...listing,
      intro: "I brief you every weekday morning.",
      firstQuestion: "Which city should I watch?",
    });
    await createBotFromTemplateDefinition(
      services({
        createBot: async (_actor, input) => {
          await input.seed(tx as never, bot.id);
          return bot;
        },
      }),
      async () => [],
      member,
      marketplaceBotTemplate(withIntro),
      { version: withIntro.version },
      { ...options, intro: marketplaceBotIntro(withIntro) },
    );
    expect(messages[0]?.blocks).toEqual([
      { kind: "text", text: "I brief you every weekday morning.\n\nWhich city should I watch?" },
    ]);
  });

  it("stays silent when the listing has no intro", async () => {
    const messages: unknown[] = [];
    const db = transactionalDb();
    const tx = new Proxy(db as object, {
      get: (target, prop) =>
        prop === "message"
          ? {
              create: async (args: { data: unknown }) => {
                messages.push(args.data);
                return { id: "message-1" };
              },
            }
          : (target as Record<string, unknown>)[prop as string],
    });
    await createBotFromTemplateDefinition(
      services({
        createBot: async (_actor, input) => {
          await input.seed(tx as never, bot.id);
          return bot;
        },
      }),
      async () => [],
      member,
      marketplaceBotTemplate(listing),
      { version: listing.version },
      { ...options, intro: marketplaceBotIntro(listing) },
    );
    expect(messages.every((data) => JSON.stringify(data).includes("import_setup"))).toBe(true);
  });

  it("returns the existing bot on a retry without creating again", async () => {
    const createBot = vi.fn(async () => bot);
    const db = transactionalDb();
    const prisma = new Proxy(db as object, {
      get: (target, prop) =>
        prop === "agentImport"
          ? {
              findFirst: async () => ({
                botId: bot.id,
                requestDigest: requestDigest(options.digest),
              }),
            }
          : (target as Record<string, unknown>)[prop as string],
    });
    const result = await createBotFromTemplateDefinition(
      { ...services({ createBot }), prisma } as unknown as AgentImportServices,
      async () => [],
      member,
      marketplaceBotTemplate(listing),
      { version: listing.version },
      options,
    );
    expect(result).toEqual({ bot, created: false });
    expect(createBot).not.toHaveBeenCalled();
  });
});
