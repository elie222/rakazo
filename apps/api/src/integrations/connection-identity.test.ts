import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { Prisma } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { findDuplicateAccount } from "./connection-identity.js";

it("propagates a database failure while reading sibling connections", async () => {
  const failure = new Error("database unavailable");
  const tx = {
    connection: { findMany: vi.fn().mockRejectedValue(failure) },
  } as unknown as Pick<Prisma.TransactionClient, "connection">;
  const connector = {
    connectedAccountIdentity: vi.fn(async () => "mailbox@example.test"),
  } as unknown as ManagedConnectorProvider;
  const context: AdapterContext = {
    spaceId: "space",
    userId: "admin",
    organizationId: "organization",
    operationId: "test",
    traceId: "test",
    signal: new AbortController().signal,
  };
  await expect(
    findDuplicateAccount(
      tx,
      connector,
      { id: "connection", connectorId: "fixture", provider: "mail" },
      "account",
      context,
    ),
  ).rejects.toBe(failure);
});
