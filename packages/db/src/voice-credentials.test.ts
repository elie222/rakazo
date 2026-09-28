import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { selectSpaceVoicePreference } from "./voice-credentials.js";

const scope = { userId: "user", spaceId: "space" };

function preferenceClient() {
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const upsert = vi.fn().mockResolvedValue({ id: "preference" });
  const prisma = { spaceVoicePreference: { updateMany, upsert } } as unknown as PrismaClient;
  return { prisma, upsert };
}

describe("selectSpaceVoicePreference", () => {
  it("leaves the speech model unchanged when the caller omits it", async () => {
    const { prisma, upsert } = preferenceClient();

    await selectSpaceVoicePreference(prisma, scope, "credential", "voice");

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ voiceId: "voice", isDefault: true }),
        update: { voiceId: "voice", isDefault: true },
      }),
    );
    const call = upsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    expect(call.create).not.toHaveProperty("speechModel");
  });

  it("stores a speech model override with the voice preference", async () => {
    const { prisma, upsert } = preferenceClient();

    await selectSpaceVoicePreference(prisma, scope, "credential", "voice", "s1");

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ speechModel: "s1" }),
        update: { voiceId: "voice", isDefault: true, speechModel: "s1" },
      }),
    );
  });

  it("clears a speech model override", async () => {
    const { prisma, upsert } = preferenceClient();

    await selectSpaceVoicePreference(prisma, scope, "credential", "voice", null);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { voiceId: "voice", isDefault: true, speechModel: null },
      }),
    );
  });
});
