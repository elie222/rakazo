/**
 * OpenAI chat-completions `tools[].function.parameters` must be a JSON Schema
 * object. Hosted proxies (OpenRouter) are lenient; local OpenAI-compatible
 * servers (LM Studio, etc.) reject missing `type: "object"` and often reject
 * zero-argument schemas that omit `properties`.
 *
 * Normalize at the adapter boundary so every openai-completions path benefits.
 * Does not invent parameter names — only ensures the required envelope.
 */
export function normalizeOpenAiToolParameters(parameters: unknown): Record<string, unknown> {
  const schema =
    parameters && typeof parameters === "object" && !Array.isArray(parameters)
      ? { ...(parameters as Record<string, unknown>) }
      : {};
  const properties =
    schema.properties != null &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? schema.properties
      : {};
  return { ...schema, type: "object", properties };
}

/** True when a schema would fail stricter OpenAI-compatible tool validators. */
export function openAiToolParametersNeedNormalization(parameters: unknown): boolean {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return true;
  const schema = parameters as Record<string, unknown>;
  if (schema.type !== "object") return true;
  return (
    schema.properties == null ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  );
}
