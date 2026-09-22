/**
 * OpenAI chat-completions `tools[].function.parameters` must be a JSON Schema
 * object. Hosted proxies (OpenRouter) are lenient; local OpenAI-compatible
 * servers (LM Studio, etc.) reject missing `type: "object"` and often reject
 * zero-argument schemas that omit `properties`. Anthropic rejects the whole
 * request when a tool's root schema carries oneOf, anyOf, or allOf.
 *
 * Normalize at the adapter boundary so every provider path benefits.
 * Does not invent parameter names — only ensures the required envelope.
 */
export function normalizeOpenAiToolParameters(parameters: unknown): Record<string, unknown> {
  const schema = flattenRootUnion(isRecord(parameters) ? { ...parameters } : {});
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return { ...schema, type: "object", properties };
}

/** True when a schema would fail stricter OpenAI-compatible tool validators. */
export function openAiToolParametersNeedNormalization(parameters: unknown): boolean {
  if (!isRecord(parameters)) return true;
  if (parameters.type !== "object") return true;
  if (rootUnionKey(parameters)) return true;
  return !isRecord(parameters.properties);
}

const ROOT_UNION_KEYS = ["oneOf", "anyOf", "allOf"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function rootUnionKey(schema: Record<string, unknown>) {
  return ROOT_UNION_KEYS.find((key) => Array.isArray(schema[key]));
}

/**
 * Merge root-level variants into one object schema: every variant's fields stay
 * visible, and only fields required by all oneOf/anyOf variants (any allOf
 * variant) stay required. Differing specs for the same field become a nested
 * anyOf, or a nested allOf when the root combinator is allOf. Exclusivity
 * between variants is lost on the wire, so the executor must keep validating
 * arguments against the original schema.
 */
function flattenRootUnion(
  schema: Record<string, unknown>,
  root = schema,
  references: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const ref = schema.$ref;
  if (typeof ref === "string" && !references.has(ref)) {
    const target = localSchemaReference(root, ref);
    if (isRecord(target)) {
      const { $ref: _ref, ...siblings } = schema;
      return flattenRootUnion({ allOf: [target, siblings] }, root, new Set([...references, ref]));
    }
  }
  const key = rootUnionKey(schema);
  if (!key) return schema;
  const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...rest } = schema;
  const variants = (schema[key] as unknown[])
    .filter(isRecord)
    .map((variant) => flattenRootUnion(variant, root, references));

  const specs = new Map<string, unknown[]>();
  for (const source of [rest, ...variants]) {
    if (!isRecord(source.properties)) continue;
    for (const [name, spec] of Object.entries(source.properties)) {
      const seen = specs.get(name) ?? [];
      if (!seen.some((other) => JSON.stringify(other) === JSON.stringify(spec))) seen.push(spec);
      specs.set(name, seen);
    }
  }
  const combinator = key === "allOf" ? "allOf" : "anyOf";
  const properties = Object.fromEntries(
    [...specs].map(([name, seen]) => [name, seen.length === 1 ? seen[0] : { [combinator]: seen }]),
  );

  const requiredOf = (source: Record<string, unknown>) =>
    Array.isArray(source.required) ? source.required.map(String) : [];
  const variantRequired = variants.map(requiredOf);
  const shared =
    key === "allOf"
      ? variantRequired.flat()
      : (variantRequired[0] ?? []).filter((name) =>
          variantRequired.every((required) => required.includes(name)),
        );
  const required = [...new Set([...requiredOf(rest), ...shared])];

  const closed =
    rest.additionalProperties === false ||
    (variants.length > 0 && variants.every((variant) => variant.additionalProperties === false));
  return {
    ...rest,
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(closed ? { additionalProperties: false } : {}),
  };
}

/** Resolve only same-document JSON pointers; never fetch external schemas. */
function localSchemaReference(root: Record<string, unknown>, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(2));
  } catch {
    return undefined;
  }
  let value: unknown = root;
  for (const token of pointer.split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
