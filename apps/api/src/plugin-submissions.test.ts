import { EmailEmulator } from "@rakazo/adapters";
import { PLUGIN_SUBMISSIONS_PATH } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const preview = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof import("@rakazo/adapters")>()),
  previewPluginInstall: preview,
}));

const { approvedPluginEntries, isAdmin, pluginSubmissionRoutes, reviewPluginSubmission } =
  await import("./plugin-submissions.js");

const SHA = "a".repeat(40);
const valid = {
  email: "dev@example.test",
  name: "Acme Tickets",
  logo: "https://example.test/logo.svg",
  source: "https://github.com/acme/plugins/tree/main/tickets",
  description: "Search Acme tickets.",
  testing: "Ask a bot to find ticket 42.",
  tested: true,
};

type Row = Record<string, unknown> & { id: string; status: string; source: string };

function fakePrisma(users: Array<{ id: string; email: string; emailVerified: boolean }> = []) {
  const rows: Row[] = [];
  const stamp = (data: Record<string, unknown>) => ({ reviewedAt: null, reason: null, ...data });
  const pluginSubmission = {
    findFirst: async ({ where }: { where: { source: string; email: string; status: string } }) =>
      rows.find(
        (row) =>
          row.source === where.source && row.email === where.email && row.status === where.status,
      ) ?? null,
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      return row ? { ...row } : null;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = stamp({
        ...data,
        id: `sub-${rows.length + 1}`,
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(0),
      }) as Row;
      rows.push(row);
      return row;
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) =>
      rows.find((row) => row.id === where.id)!,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((candidate) => candidate.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; status: string; updatedAt?: Date };
      data: Record<string, unknown>;
    }) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      if (!row || row.status !== where.status) return { count: 0 };
      if (where.updatedAt && where.updatedAt !== row.updatedAt) return { count: 0 };
      Object.assign(row, data, { updatedAt: new Date() });
      return { count: 1 };
    },
    findMany: async () => rows.filter((row) => row.status === "approved" && row.pinnedSource),
  };
  const user = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      users.find((candidate) => candidate.id === where.id) ?? null,
  };
  return { rows, prisma: { pluginSubmission, user } as never };
}

function routes(prisma: never, email = new EmailEmulator()) {
  const app = pluginSubmissionRoutes({
    prisma,
    email,
    adminEmails: ["admin@example.test"],
    webOrigin: "https://app.example.test",
    clientIp: () => "203.0.113.7",
    onEmailError: (error) => {
      throw error;
    },
  });
  const submit = (body: unknown) =>
    app.request(PLUGIN_SUBMISSIONS_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { submit, email };
}

beforeEach(() => preview.mockReset());

describe("public plugin submissions", () => {
  it("stores the repository, branch and folder and emails the submitter and admins", async () => {
    const { rows, prisma } = fakePrisma();
    const { submit, email } = routes(prisma);
    const response = await submit(valid);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "sub-1", status: "pending" });
    expect(rows[0]).toMatchObject({
      source: "https://github.com/acme/plugins@main#tickets",
      website: null,
    });
    await vi.waitFor(() => expect(email.sent).toHaveLength(2));
    const submitter = email.sent.find((message) => message.to === valid.email)!;
    // Anyone can type any address, so the confirmation repeats nothing they wrote.
    expect(submitter.text).not.toContain(valid.name);
    const admin = email.sent.find((message) => message.to === "admin@example.test")!;
    expect(admin.subject).toContain(valid.name);
    expect(admin.text).toContain("https://app.example.test/admin/plugins");
  });

  it("updates a pending submission for the same repository instead of queueing it twice", async () => {
    const { rows, prisma } = fakePrisma();
    const { submit, email } = routes(prisma);
    await submit(valid);
    const again = await submit({ ...valid, description: "Better words." });
    expect(again.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe("Better words.");
    // Admins hear about the first one only.
    await vi.waitFor(() => expect(email.sent).toHaveLength(3));
    expect(email.sent.filter((message) => message.to === "admin@example.test")).toHaveLength(1);
  });

  it("never lets someone else replace a pending submission", async () => {
    const { rows, prisma } = fakePrisma();
    const { submit } = routes(prisma);
    await submit(valid);
    const other = await submit({ ...valid, email: "someone@example.test", description: "Mine." });
    expect(other.status).toBe(201);
    expect(rows.map((row) => [row.email, row.description])).toEqual([
      [valid.email, valid.description],
      ["someone@example.test", "Mine."],
    ]);
  });

  it.each([
    ["a non-GitHub source", { source: "https://gitlab.com/acme/plugin" }, "source"],
    ["an http logo", { logo: "http://example.test/logo.svg" }, "logo"],
    ["an untested plugin", { tested: false }, "tested"],
    ["a missing email", { email: "" }, "email"],
  ])("rejects %s and names the field", async (_name, change, field) => {
    const { rows, prisma } = fakePrisma();
    const response = await routes(prisma).submit({ ...valid, ...change });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: Array<{ field: string }> };
    expect(body.issues.map((issue) => issue.field)).toContain(field);
    expect(rows).toHaveLength(0);
  });

  it("limits submissions per address", async () => {
    const { prisma } = fakePrisma();
    const { submit } = routes(prisma, new EmailEmulator());
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (await submit({ ...valid, source: `https://github.com/acme/plugin-${i}` })).status,
      );
    }
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("isAdmin", () => {
  const users = [
    { id: "verified", email: "Admin@Example.test", emailVerified: true },
    { id: "unverified", email: "admin@example.test", emailVerified: false },
  ];

  it("requires a listed, verified email", async () => {
    const { prisma } = fakePrisma(users);
    const deps = { prisma, env: { adminEmails: ["admin@example.test"] } };
    expect(await isAdmin(deps, "verified")).toBe(true);
    expect(await isAdmin(deps, "unverified")).toBe(false);
    expect(await isAdmin({ prisma, env: {} }, "verified")).toBe(false);
  });
});

describe("reviewing submissions", () => {
  async function submitted() {
    const { rows, prisma } = fakePrisma();
    await routes(prisma).submit(valid);
    const email = new EmailEmulator();
    const deps = {
      prisma,
      email,
      onEmailError: (error: unknown) => {
        throw error;
      },
      env: {} as never,
    };
    return { rows, prisma, email, deps };
  }

  it("rejects with a reason the submitter is emailed", async () => {
    const { deps, email } = await submitted();
    const result = await reviewPluginSubmission(deps, {
      id: "sub-1",
      decision: "reject",
      reason: "The MCP server returned errors.",
    });
    expect(result).toMatchObject({
      status: "rejected",
      reason: "The MCP server returned errors.",
      // Admins open the branch and folder that was submitted.
      source: "https://github.com/acme/plugins/tree/main/tickets",
    });
    await vi.waitFor(() => expect(email.sent).toHaveLength(1));
    expect(email.sent[0]!.text).toContain("The MCP server returned errors.");
    expect(preview).not.toHaveBeenCalled();
  });

  it("approves the previewed commit and lists it in the marketplace", async () => {
    const { deps, prisma } = await submitted();
    preview.mockResolvedValue({
      source: { gitUrl: "https://github.com/acme/plugins", subdir: "tickets" },
      resolvedSha: SHA,
      mcpServers: [],
      skills: [{ name: "a" }, { name: "b" }],
      skipped: [],
    });
    await reviewPluginSubmission(deps, { id: "sub-1", decision: "approve" });
    expect(await approvedPluginEntries(prisma)).toEqual([
      expect.objectContaining({
        name: "acme-tickets",
        displayName: "Acme Tickets",
        registry: "Rakazo",
        source: `https://github.com/acme/plugins@${SHA}#tickets`,
        installedSource: "https://github.com/acme/plugins#tickets",
        hasConnector: false,
        skillCount: 2,
      }),
    ]);
  });

  it("refuses a plugin with nothing to install", async () => {
    const { deps, rows } = await submitted();
    preview.mockResolvedValue({
      source: { gitUrl: "https://github.com/acme/plugins" },
      resolvedSha: SHA,
      mcpServers: [],
      skills: [],
      skipped: [],
    });
    await expect(
      reviewPluginSubmission(deps, { id: "sub-1", decision: "approve" }),
    ).rejects.toThrow("This plugin has no skills or MCP servers");
    expect(rows[0]!.status).toBe("pending");
  });

  it("keeps the first decision when another admin decides during the preview", async () => {
    const { deps, rows, email } = await submitted();
    preview.mockImplementation(async () => {
      rows[0]!.status = "rejected";
      return {
        source: { gitUrl: "https://github.com/acme/plugins" },
        resolvedSha: SHA,
        mcpServers: [],
        skills: [{ name: "a" }],
        skipped: [],
      };
    });
    await expect(
      reviewPluginSubmission(deps, { id: "sub-1", decision: "approve" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(rows[0]!.status).toBe("rejected");
    expect(email.sent).toHaveLength(0);
  });

  it("does not approve a listing the author changed during the preview", async () => {
    const { deps, rows } = await submitted();
    preview.mockImplementation(async () => {
      Object.assign(rows[0]!, { name: "Changed", updatedAt: new Date() });
      return {
        source: { gitUrl: "https://github.com/acme/plugins" },
        resolvedSha: SHA,
        mcpServers: [],
        skills: [{ name: "tickets" }],
        skipped: [],
      };
    });
    await expect(
      reviewPluginSubmission(deps, { id: "sub-1", decision: "approve" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(rows[0]!.status).toBe("pending");
  });

  it("keeps a plugin that would install only in part pending", async () => {
    const { deps, rows } = await submitted();
    preview.mockResolvedValue({
      source: { gitUrl: "https://github.com/acme/plugins" },
      resolvedSha: SHA,
      mcpServers: [],
      skills: [],
      skipped: [{ kind: "stdio_server" }],
    });
    await expect(
      reviewPluginSubmission(deps, { id: "sub-1", decision: "approve" }),
    ).rejects.toThrow("This plugin would only install in part");
    expect(rows[0]!.status).toBe("pending");
  });
});
