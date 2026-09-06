/**
 * Operator-declared input modalities for self-configured model endpoints.
 *
 * Pi's built-in catalog knows the modalities of hosted models, but a model
 * reached through `local` or `openai-compatible` is whatever the operator
 * points it at. Those providers therefore declare `["text"]`, which is the
 * safe default: `modelAcceptsImageInput` gates the screenshot-returning
 * computer tools on `input.includes("image")`, so guessing "image" for an
 * endpoint that cannot see would send screenshots into a text-only model.
 *
 * Defaulting to text-only is right; having no way to say otherwise is not.
 * An operator fronting a vision model through a gateway (LiteLLM, LM Studio,
 * vLLM) knows it can see, and this is how they say so.
 */

/** Comma-separated model ids the operator declares vision-capable. */
export function declaredVisionModelIds(envName: string): ReadonlySet<string> {
  return new Set(
    (process.env[envName] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/** The `input` modality list for a model, given whether it accepts images. */
export function inputModalities(acceptsImages: boolean): ("text" | "image")[] {
  return acceptsImages ? ["text", "image"] : ["text"];
}
