import type * as Db from "@rakazo/db";
import type { ModelRoleTarget, PrismaClient } from "@rakazo/db";
import { updateModelRole } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { clearOpenRouterMediaModelsForTest } from "../providers/media/openrouter/openrouter-media-models.js";
import {
  MediaModelUnavailableError,
  mediaModelsView,
  setMediaModel,
} from "./media-model-choices.js";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  updateModelRole: vi.fn(),
}));

const target: ModelRoleTarget = { userId: "owner", spaceId: "space", scope: "account" };

function prisma(
  connections: Array<{ id: string; label: string; provider?: string }>,
  chosen: { credentialId: string; modelId: string } | null = null,
) {
  return {
    userModelCredential: {
      findMany: vi
        .fn()
        .mockResolvedValue(connections.map((row) => ({ provider: "openai", ...row }))),
    },
    userModelRoleChoice: {
      findMany: vi.fn(async ({ where }: { where: { role: string } }) =>
        chosen && where.role === "image"
          ? [{ ...chosen, role: "image", position: 0, provider: "openai", thinkingLevel: null }]
          : [],
      ),
    },
  } as unknown as PrismaClient;
}

describe("media model choices", () => {
  it("offers each connection's image models and runs the newest one's default", async () => {
    const view = await mediaModelsView(
      prisma([
        { id: "newer", label: "Work" },
        { id: "older", label: "Personal" },
      ]),
      target,
    );
    expect(view.image.selected).toEqual({ credentialId: "newer", modelId: "gpt-image-2" });
    expect(view.image.options[0]).toEqual({
      credentialId: "newer",
      modelId: "gpt-image-2",
      label: "GPT Image 2",
      provider: "openai",
      connectionLabel: "Work",
    });
    expect(view.image.options.some((option) => option.credentialId === "older")).toBe(true);
    expect(view.video).toEqual({ options: [], selected: null });
  });

  it("shows the chosen model as the one bots use", async () => {
    const view = await mediaModelsView(
      prisma([{ id: "key", label: "Work" }], { credentialId: "key", modelId: "gpt-image-1-mini" }),
      target,
    );
    expect(view.image.selected).toEqual({ credentialId: "key", modelId: "gpt-image-1-mini" });
    expect(view.image.options.map((option) => option.label)).toContain("GPT Image 1 Mini");
  });

  it("refuses a model the connection does not offer for that media", async () => {
    const db = prisma([{ id: "key", label: "Work" }]);
    for (const [role, modelId] of [
      ["image", "lab/unknown"],
      ["video", "gpt-image-2"],
    ] as const)
      await expect(
        setMediaModel(db, target, role, { credentialId: "key", modelId }),
      ).rejects.toBeInstanceOf(MediaModelUnavailableError);
  });

  it("keeps a pick while the connection's model catalog cannot be read", async () => {
    clearOpenRouterMediaModelsForTest();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const db = prisma([{ id: "key", label: "Work", provider: "openrouter" }]);
    try {
      await setMediaModel(db, target, "image", { credentialId: "key", modelId: "lab/draw" });
      expect(updateModelRole).toHaveBeenCalledWith(db, target, "image", {
        primary: { provider: "openrouter", modelId: "lab/draw", credentialId: "key" },
        backups: [],
      });
    } finally {
      vi.unstubAllGlobals();
      clearOpenRouterMediaModelsForTest();
    }
  });
});
