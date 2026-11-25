import { deadlineSignal } from "@rakazo/core";
import { z } from "zod";
import { isMediaModelId } from "../../../media/images-api.js";
import type { MediaModelOption } from "../../../media/media-models.js";
import { readBodyCapped } from "../../../web/web-ssrf.js";
import { VIDEO_SECONDS } from "./openrouter-media.js";

const API = "https://openrouter.ai/api/v1";
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2_000_000;
const FRESH_MS = 60 * 60_000;

const named = { id: z.string().refine(isMediaModelId), name: z.string().min(1).max(200) };
const imageEntry = z.object({
  ...named,
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }),
});
const videoEntry = z.object({
  ...named,
  supported_durations: z.array(z.number()).nullable().optional(),
});

/** Whether a listed model makes media from a prompt alone, the way generation asks for it. */
const makesFromPrompt = {
  images: (entry: unknown) => {
    const parsed = imageEntry.safeParse(entry);
    return parsed.success &&
      parsed.data.architecture.input_modalities.includes("text") &&
      parsed.data.architecture.output_modalities.includes("image")
      ? parsed.data
      : undefined;
  },
  video: (entry: unknown) => {
    const parsed = videoEntry.safeParse(entry);
    return parsed.success && parsed.data.supported_durations?.includes(VIDEO_SECONDS)
      ? parsed.data
      : undefined;
  },
};

const cached = new Map<"images" | "video", { at: number; models: Promise<MediaModelOption[]> }>();

/** The public image or video catalog, kept for an hour; a failed read is not kept. */
export function openRouterMediaModels(
  kind: "images" | "video",
  fetcher: typeof fetch = fetch,
): Promise<MediaModelOption[]> {
  const hit = cached.get(kind);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.models;
  const models = readCatalog(kind, fetcher);
  cached.set(kind, { at: Date.now(), models });
  models.catch(() => {
    if (cached.get(kind)?.models === models) cached.delete(kind);
  });
  return models;
}

async function readCatalog(kind: "images" | "video", fetcher: typeof fetch) {
  const signal = deadlineSignal(TIMEOUT_MS);
  const response = await fetcher(`${API}/${kind === "images" ? "images" : "videos"}/models`, {
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Media model catalog answered ${response.status}`);
  }
  const body = z
    .object({ data: z.array(z.unknown()) })
    .parse(JSON.parse(new TextDecoder().decode(await readBodyCapped(response, MAX_BYTES, signal))));
  return body.data.flatMap((entry) => {
    const model = makesFromPrompt[kind](entry);
    return model ? [{ id: model.id, label: model.name }] : [];
  });
}

export function clearOpenRouterMediaModelsForTest() {
  cached.clear();
}
