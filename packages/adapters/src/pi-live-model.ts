import type { Api, Model, Models } from "@earendil-works/pi-ai";

/** Models endpoints often mix chat models with tools and media endpoints. */
export function isChatModelId(id: string): boolean {
  return (
    /^[\x21-\x7e]{1,1024}$/.test(id) &&
    !/(embed|(?:^|[-/_])tts(?:[-/_]|$)|whisper|transcrib|audio|realtime|dall-e|gpt-image|imagen|moderation|rerank|stable-diffusion|\bflux\b|image|text-to-speech|speech-to-text|\bsora\b|\bveo\b|video|\bocr\b|davinci|babbage|turbo-instruct|computer-use)/i.test(
      id,
    )
  );
}

/** A deterministic fallback shared by listing and execution; never changes provider or host. */
export function liveModelSibling(
  models: Models,
  provider: string,
  id: string,
): Model<Api> | undefined {
  if (!isChatModelId(id)) return undefined;
  const siblings =
    models
      .getProvider?.(provider)
      ?.getModels()
      .filter((model) =>
        ["openai-completions", "openai-responses", "openai-codex-responses"].includes(model.api),
      ) ?? [];
  const urls = new Set(siblings.map((model) => model.baseUrl));
  if (urls.size !== 1 || siblings.length === 0) return undefined;
  const url = new URL(siblings[0]!.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || /[{}]/.test(url.href))
    return undefined;
  const prefixLength = (other: string) => {
    let n = 0;
    while (n < id.length && id[n] === other[n]) n++;
    return n;
  };
  const sibling = [...siblings].sort((a, b) => prefixLength(b.id) - prefixLength(a.id))[0]!;
  // Only a date/alias variant proves the same family and its capabilities.
  const family = (value: string) => value.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{4,8}|latest)$/, "");
  const sameFamily = family(id) === family(sibling.id);
  return {
    ...sibling,
    id,
    name: id,
    reasoning: sameFamily && sibling.reasoning,
    input: sameFamily ? [...sibling.input] : ["text"],
  };
}
