import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  actorHasConnectorToolPermission,
  connectorToolPermissionNeeded,
  denyConnectorToolMessage,
  loadGlobalBotConnectorPacks,
  loadSpaceActorPermissions,
  resolveGlobalBotPackMcpAccess,
  resolveGlobalBotPackSkills,
} from "./global-bot-connectors.js";

describe("connectorToolPermissionNeeded", () => {
  it("requires finance.read for list/query tools", () => {
    expect(connectorToolPermissionNeeded("mcp__books__list_accounts", true)).toBe("finance.read");
    expect(connectorToolPermissionNeeded("monarch_get_transactions")).toBe("finance.read");
    expect(connectorToolPermissionNeeded("search_budgets", true)).toBe("finance.read");
  });

  it("requires finance.write for mutating tools", () => {
    expect(connectorToolPermissionNeeded("mcp__books__create_transfer", false)).toBe(
      "finance.write",
    );
    expect(connectorToolPermissionNeeded("monarch_update_transaction")).toBe("finance.write");
    expect(connectorToolPermissionNeeded("pay_bill")).toBe("finance.write");
  });

  it("treats an explicit write hint as finance.write even with a read-like name", () => {
    expect(connectorToolPermissionNeeded("list_then_update", false)).toBe("finance.write");
  });
});

describe("actorHasConnectorToolPermission", () => {
  it("allows member reads and denies member writes by default", () => {
    expect(actorHasConnectorToolPermission({ role: "member" }, "finance.read")).toBe(true);
    expect(actorHasConnectorToolPermission({ role: "member" }, "finance.write")).toBe(false);
    expect(actorHasConnectorToolPermission({ role: "owner" }, "finance.write")).toBe(true);
  });

  it("honors space role overrides", () => {
    expect(
      actorHasConnectorToolPermission({ role: "member" }, "finance.write", [
        { role: "member", permission: "finance.read" },
        { role: "member", permission: "finance.write" },
      ]),
    ).toBe(true);
  });
});

describe("denyConnectorToolMessage", () => {
  it("names the missing permission", () => {
    expect(denyConnectorToolMessage("pay_bill", "finance.write")).toContain("finance.write");
    expect(denyConnectorToolMessage("list_accounts", "finance.read")).toContain("finance.read");
  });
});

describe("loadGlobalBotConnectorPacks", () => {
  it("orders packs by attach position", async () => {
    const prisma = {
      globalBotConnector: {
        findMany: vi.fn(async () => [
          {
            position: 1,
            connector: {
              id: "c2",
              slug: "ledger",
              name: "Ledger",
              skillRefs: ["budget"],
              mcpConfig: { serverSlugs: ["books"] },
            },
          },
          {
            position: 0,
            connector: {
              id: "c1",
              slug: "monarch",
              name: "Monarch",
              skillRefs: [],
              mcpConfig: {},
            },
          },
        ]),
      },
    };
    await expect(loadGlobalBotConnectorPacks(prisma as never, "g1")).resolves.toEqual([
      {
        id: "c2",
        slug: "ledger",
        name: "Ledger",
        skillRefs: ["budget"],
        mcpConfig: { serverSlugs: ["books"] },
        position: 1,
      },
      {
        id: "c1",
        slug: "monarch",
        name: "Monarch",
        skillRefs: [],
        mcpConfig: {},
        position: 0,
      },
    ]);
    expect(prisma.globalBotConnector.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { globalBotId: "g1" },
        orderBy: [{ position: "asc" }, { connectorId: "asc" }],
      }),
    );
  });
});

describe("resolveGlobalBotPackMcpAccess", () => {
  it("prefers the chatting user's MCP server for a pack slug", async () => {
    const prisma = {
      mcpServer: {
        findMany: vi.fn(async () => [
          { id: "s-other", slug: "books", userId: "u-other", enabled: true },
          { id: "s-mine", slug: "books", userId: "u-me", enabled: true },
        ]),
      },
    };
    await expect(
      resolveGlobalBotPackMcpAccess(prisma as never, {
        spaceId: "space-1",
        userId: "u-me",
        packs: [
          {
            id: "c1",
            slug: "finance",
            name: "Finance",
            skillRefs: [],
            mcpConfig: { serverSlugs: ["books"], allowedToolsBySlug: { books: ["list_accounts"] } },
            position: 0,
          },
        ],
      }),
    ).resolves.toEqual([
      {
        serverId: "s-mine",
        slug: "books",
        allowAllTools: false,
        allowedTools: ["list_accounts"],
        connectorId: "c1",
        connectorSlug: "finance",
      },
    ]);
  });
});

describe("resolveGlobalBotPackSkills", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("matches skill refs by id or name", async () => {
    const prisma = {
      agentSkill: {
        findMany: vi.fn(async () => [
          {
            id: "sk-1",
            name: "Budget review",
            description: "Review budgets",
            content: "# Budget",
            source: "user",
            readOnly: true,
          },
        ]),
      },
    };
    // Builtin skills also merge in; assert the pack-named skill is present.
    const matched = await resolveGlobalBotPackSkills(
      prisma as never,
      { spaceId: "space-1", userId: "u1" },
      [
        {
          id: "c1",
          slug: "finance",
          name: "Finance",
          skillRefs: ["Budget review", "missing"],
          mcpConfig: {},
          position: 0,
        },
      ],
    );
    expect(matched.some((skill) => skill.id === "sk-1")).toBe(true);
  });
});

describe("loadSpaceActorPermissions", () => {
  it("loads role defaults and overrides", async () => {
    const prisma = {
      spaceMember: {
        findUnique: vi.fn(async () => ({ role: "member" })),
      },
      spaceRolePermission: {
        findMany: vi.fn(async () => [
          { role: "member", permission: "finance.read" },
          { role: "member", permission: "finance.write" },
        ]),
      },
    };
    const auth = await loadSpaceActorPermissions(prisma as never, {
      spaceId: "space-1",
      userId: "u1",
    });
    expect(auth.role).toBe("member");
    expect(auth.permissions.has("finance.write")).toBe(true);
  });
});
