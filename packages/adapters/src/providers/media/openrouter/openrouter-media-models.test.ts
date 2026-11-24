import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOpenRouterMediaModelsForTest,
  openRouterMediaModels,
} from "./openrouter-media-models.js";

const catalog = (data: unknown[]) =>
  vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ data })));

describe("OpenRouter media model catalogs", () => {
  beforeEach(clearOpenRouterMediaModelsForTest);

  it("lists image models that draw from a prompt alone", async () => {
    const fetcher = catalog([
      {
        id: "lab/draw",
        name: "Lab: Draw",
        architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
      },
      {
        id: "lab/edit-only",
        name: "Lab: Edit",
        architecture: { input_modalities: ["image"], output_modalities: ["image"] },
      },
      { id: "lab/malformed", name: "Lab: Broken" },
    ]);
    expect(await openRouterMediaModels("images", fetcher)).toEqual([
      { id: "lab/draw", label: "Lab: Draw" },
    ]);
    expect(fetcher.mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/images/models");
  });

  it("lists video models that make the clip length generation asks for", async () => {
    const fetcher = catalog([
      { id: "lab/clip", name: "Lab: Clip", supported_durations: [4, 6, 8] },
      { id: "lab/long", name: "Lab: Long", supported_durations: [5, 10] },
      { id: "lab/upscale", name: "Lab: Upscale", supported_durations: null },
    ]);
    expect(await openRouterMediaModels("video", fetcher)).toEqual([
      { id: "lab/clip", label: "Lab: Clip" },
    ]);
  });

  it("reads the catalog again after a failed read", async () => {
    const failing = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(openRouterMediaModels("video", failing)).rejects.toThrow();
    const fetcher = catalog([{ id: "lab/clip", name: "Lab: Clip", supported_durations: [4] }]);
    expect(await openRouterMediaModels("video", fetcher)).toHaveLength(1);
  });
});
