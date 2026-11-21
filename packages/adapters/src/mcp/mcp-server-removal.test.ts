import type * as db from "@rakazo/db";
import type { Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { removeMcpServerInTransaction } from "./mcp-server-removal.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
}));

/** PostgreSQL jsonb `@>` containment, which Prisma `array_contains` compiles to. */
function jsonContains(value: unknown, needle: unknown): boolean {
  if (Array.isArray(needle)) {
    return (
      Array.isArray(value) &&
      needle.every((item) => value.some((candidate) => jsonContains(candidate, item)))
    );
  }
  if (needle !== null && typeof needle === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.entries(needle).every(([key, item]) => jsonContains(record[key], item));
  }
  return value === needle;
}

describe("removeMcpServerInTransaction", () => {
  it("dismisses the server's cards, then deletes it and its credential", async () => {
    const blocks = [
      { kind: "mcp_approval", name: "A", serverId: "srv-a", status: "connected" },
      { kind: "mcp_approval", name: "Open", serverId: "srv-a", status: "pending" },
      { kind: "mcp_approval", name: "C", serverId: "srv-a", status: "dismissed" },
    ];
    const rows = [
      {
        id: "card-message",
        botId: null,
        threadId: "group-thread",
        thread: { botId: "bot" },
        blocks,
      },
      {
        id: "mention",
        botId: "bot",
        threadId: "group-thread",
        thread: { botId: "bot" },
        blocks: [{ kind: "text", text: "server srv-a is gone" }],
      },
      {
        id: "other-server",
        botId: "bot",
        threadId: "group-thread",
        thread: { botId: "bot" },
        blocks: [{ kind: "mcp_approval", name: "B", serverId: "srv-b", status: "connected" }],
      },
    ];
    const tx = {
      message: {
        findMany: vi.fn(async (query: { where: { blocks: { array_contains: unknown } } }) =>
          rows.filter((row) => jsonContains(row.blocks, query.where.blocks.array_contains)),
        ),
        update: vi.fn(),
      },
      mcpServer: { delete: vi.fn() },
      secret: { deleteMany: vi.fn() },
    };
    const seqs = await removeMcpServerInTransaction(
      tx as unknown as Prisma.TransactionClient,
      { spaceId: "space", userId: "user" },
      { id: "srv-a", secretId: "sec-a" },
    );
    expect(seqs).toEqual([{ threadId: "group-thread", seq: 7 }]);
    expect(tx.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ thread: { spaceId: "space" } }) }),
    );
    expect(tx.message.update).toHaveBeenCalledTimes(1);
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: {
        blocks: [
          { ...blocks[0], status: "dismissed" },
          { ...blocks[1], status: "dismissed" },
          blocks[2],
        ],
      },
    });
    expect(tx.mcpServer.delete).toHaveBeenCalledWith({ where: { id: "srv-a" } });
    expect(tx.secret.deleteMany).toHaveBeenCalledWith({
      where: { id: "sec-a", userId: "user" },
    });
  });
});
