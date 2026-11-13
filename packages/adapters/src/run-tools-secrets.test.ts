import { expect, it, vi } from "vitest";
import type * as BotSecrets from "./bot-secrets.js";
import { listBotSecrets } from "./bot-secrets.js";
import { secretTools } from "./run-tools-secrets.js";

vi.mock("./bot-secrets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof BotSecrets>()),
  listBotSecrets: vi.fn(),
}));

it("returns secret previews without persisting decrypted content in an effect result", async () => {
  const preview = { secrets: [{ name: "contact", contact: { email: "test@example.com" } }] };
  vi.mocked(listBotSecrets).mockResolvedValue(preview as never);
  const finish = vi.fn();
  const handler = secretTools.list_secrets;
  const ctx = { deps: { prisma: {}, secretStore: {} }, run: { id: "run-1" } };
  expect(
    await handler(
      ctx as unknown as Parameters<typeof handler>[0],
      { finish } as unknown as Parameters<typeof handler>[1],
    ),
  ).toEqual(preview);
  expect(finish).not.toHaveBeenCalled();
});
