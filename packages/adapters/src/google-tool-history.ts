import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

/** Keep foreign tool history usable without replaying another model's signatures. */
export function withGoogleToolHistory(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
): SimpleStreamOptions {
  if (model.api !== "google-generative-ai" && model.api !== "google-vertex") return options;
  const foreign = new WeakSet<object>();
  const native = new WeakSet<object>();
  let hasForeignCalls = false;
  for (const message of context.messages) {
    if (message.role !== "assistant") continue;
    const sameModel = message.provider === model.provider && message.model === model.id;
    for (const part of message.content) {
      if (part.type !== "toolCall" || !isRecord(part.arguments)) continue;
      (sameModel ? native : foreign).add(part.arguments);
      hasForeignCalls ||= !sameModel;
    }
  }
  if (!hasForeignCalls) return options;
  return {
    ...options,
    async onPayload(payload, requestedModel) {
      // Pi retains argument object identity in its Google payload. Do not match tool
      // names or guess which unsigned native parts belong to a parallel call.
      if (isRecord(payload) && Array.isArray(payload.contents)) {
        for (const content of payload.contents) {
          if (!isRecord(content) || content.role !== "model" || !Array.isArray(content.parts))
            continue;
          for (const part of content.parts) {
            if (
              !isRecord(part) ||
              part.thoughtSignature !== undefined ||
              !isRecord(part.functionCall)
            )
              continue;
            const args = part.functionCall.args;
            if (isRecord(args) && foreign.has(args) && !native.has(args)) {
              // Google's documented escape hatch is only for transferred history:
              // https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures#faqs
              part.thoughtSignature = "skip_thought_signature_validator";
            }
          }
        }
      }
      const replacement = await options.onPayload?.(payload, requestedModel);
      return replacement === undefined ? payload : replacement;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
