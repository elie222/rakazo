import { Type } from "@earendil-works/pi-ai";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import {
  normalizeOpenAiToolParameters,
  openAiToolParametersNeedNormalization,
} from "./openai-tool-parameters.js";
import { argumentGiven } from "./update-bot-patch.js";

/** Build AgentTool.parameters for a connector tool, including OpenAI wire fidelity. */
export function parametersFor(tool: ConnectorTool) {
  const builtin = builtinParameters(tool);
  const schema = builtin
    ? withDeclaredDescriptions(builtin, tool.inputSchema)
    : safeJsonSchemaParameters(tool);
  // Type.Union (top-level oneOf/anyOf) serializes without type/properties, and
  // Anthropic rejects a root union, so it is flattened into one object schema.
  // Re-wrap only when needed so Type.Object schemas keep TypeBox Kind metadata.
  if (!openAiToolParametersNeedNormalization(schema)) return schema;
  return Type.Unsafe(
    normalizeOpenAiToolParameters(JSON.parse(JSON.stringify(schema))),
  ) as unknown as ReturnType<typeof Type.Object>;
}

/** builtinParameters hand-builds stricter schemas for some tools, and those carried none of
 * the parameter descriptions the tool declares. Copy each declared description onto the
 * matching top-level field. The schema is built fresh per call, so this mutates no shared
 * node. */
function withDeclaredDescriptions<T>(schema: T, declared: unknown): T {
  const fields = (schema as { properties?: Record<string, Record<string, unknown>> }).properties;
  const source = (
    declared as { properties?: Record<string, { description?: unknown }> } | undefined
  )?.properties;
  if (!fields || !source) return schema;
  for (const [key, spec] of Object.entries(source)) {
    const field = fields[key];
    if (
      field &&
      field.description === undefined &&
      typeof spec?.description === "string" &&
      spec.description
    ) {
      field.description = spec.description;
    }
  }
  return schema;
}

/** A remote MCP server controls its own schemas, so a shape TypeBox cannot express must
 * degrade to a permissive object instead of failing every turn for the whole bot. */
function safeJsonSchemaParameters(tool: ConnectorTool) {
  try {
    return jsonSchemaParameters(tool.inputSchema);
  } catch (error) {
    getLogger().error(`unsupported input schema for tool ${tool.name}`, error);
    return Type.Object({});
  }
}

function builtinParameters(tool: ConnectorTool) {
  if (tool.name === "write_file") {
    return Type.Object({ path: Type.String(), content: Type.String() });
  }
  if (tool.name === "request_takeover") {
    return Type.Object({ reason: Type.String() });
  }
  if (tool.name === "ask_user") {
    return Type.Object({
      question: Type.String({ maxLength: 240 }),
      options: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
        minItems: 2,
        maxItems: 4,
        uniqueItems: true,
      }),
    });
  }
  if (tool.name === "remember") {
    return Type.Object({ content: Type.String(), path: Type.String() });
  }
  if (tool.name === "shell") {
    return Type.Object({
      command: Type.String(),
      cwd: Type.Optional(Type.String()),
    });
  }
  if (tool.name === "run_subagent") {
    return Type.Object({
      name: Type.String(),
      task: Type.String(),
      instructions: Type.Optional(Type.String()),
      model_provider: Type.Optional(Type.String()),
      model_id: Type.Optional(Type.String()),
    });
  }
  if (tool.name === "spawn_bot") {
    return Type.Object({
      name: Type.String(),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      instructions: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      computer_mode: Type.Optional(stringEnum(["team", "dedicated"], {})),
    });
  }
  if (tool.name === "update_bot") {
    return Type.Object({
      name: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      color: Type.Optional(Type.String()),
      artifact_id: Type.Optional(Type.String()),
      use_attached_image: Type.Optional(Type.Boolean()),
      notifyOnFinish: Type.Optional(Type.Boolean()),
      bot_id: Type.Optional(Type.String()),
    });
  }
  if (tool.name === "list_fleet") return Type.Object({ bot_id: Type.Optional(Type.String()) });
  if (tool.name === "create_group") {
    return Type.Object({
      name: Type.String({ minLength: 1 }),
      bot_ids: Type.Optional(Type.Array(Type.String())),
      bot_names: Type.Optional(Type.Array(Type.String())),
    });
  }
  if (tool.name === "update_group") {
    return Type.Object({
      group_id: Type.Optional(Type.String()),
      group_name: Type.Optional(Type.String()),
      name: Type.Optional(Type.String({ minLength: 1 })),
      add_bot_ids: Type.Optional(Type.Array(Type.String())),
      remove_bot_ids: Type.Optional(Type.Array(Type.String())),
    });
  }
  if (tool.name === "organize_bot") {
    return Type.Object({
      bot_id: Type.Optional(Type.String()),
      bot_name: Type.Optional(Type.String()),
      group_id: Type.Optional(Type.String()),
      group_name: Type.Optional(Type.String()),
      section: Type.Optional(Type.String({ minLength: 1 })),
      clear_section: Type.Optional(Type.Boolean()),
      pinned: Type.Optional(Type.Boolean()),
    });
  }
  if (tool.name === "set_child_instructions") {
    return Type.Object({
      bot_id: Type.Optional(Type.String()),
      bot_name: Type.Optional(Type.String()),
      instructions: Type.String({ minLength: 1, maxLength: BOT_INSTRUCTIONS_MAX_LENGTH }),
      expected_version: Type.String(),
    });
  }
  if (tool.name === "set_child_bot_model") {
    return Type.Object({
      bot_id: Type.Optional(Type.String()),
      bot_name: Type.Optional(Type.String()),
      provider: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinking_level: Type.Optional(Type.String()),
      clear: Type.Optional(Type.Boolean()),
    });
  }
  if (tool.name === "create_space") {
    return Type.Object({ name: Type.String({ minLength: 1, maxLength: 60 }) });
  }
  if (tool.name === "archive_bot" || tool.name === "delete_bot") {
    return Type.Object({
      confirm_name: Type.String(),
      bot_id: Type.Optional(Type.String()),
    });
  }
  return undefined;
}

export function jsonSchemaParameters(
  schema: Record<string, unknown>,
  options: FieldOptions = {},
): ReturnType<typeof Type.Object> {
  // Keep intersections intact until parametersFor flattens root combinators.
  // Rebuilding only properties here drops allOf-only fields and their constraints.
  if (Array.isArray(schema.allOf)) {
    return Type.Unsafe({ ...schema, ...options }) as unknown as ReturnType<typeof Type.Object>;
  }
  // Top-level oneOf/anyOf (e.g. request_secret's credential XOR connectionId)
  // must stay a union. Falling through to properties would drop the exclusivity
  // and re-expose both destinations as optional siblings.
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (alternatives && alternatives.length > 0 && schema.properties == null) {
    return Type.Union(
      alternatives.map((variant) => jsonSchemaParameters(variant as Record<string, unknown>)),
      options,
    ) as unknown as ReturnType<typeof Type.Object>;
  }
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const fields: Record<string, ReturnType<typeof Type.Optional>> = {};
  for (const [key, spec] of Object.entries(properties)) {
    const field = jsonField(spec);
    fields[key] = (required.has(key) ? field : Type.Optional(field)) as unknown as ReturnType<
      typeof Type.Optional
    >;
  }
  // Preserve closed objects (e.g. request_secret destination oneOf branches).
  // Type.Object defaults to open, which would let connectionId+replace match both
  // anyOf variants after conversion.
  return schema.additionalProperties === false
    ? Type.Object(fields, { ...options, additionalProperties: false })
    : Type.Object(fields, options);
}

type FieldOptions = { description?: string };

/** Carry the parameter description when rebuilding its TypeBox node. */
function fieldOptions(definition: Record<string, unknown>): FieldOptions {
  return typeof definition.description === "string" && definition.description
    ? { description: definition.description }
    : {};
}

const FLEET_STRING_ARGS = [
  "bot_id",
  "bot_name",
  "group_id",
  "group_name",
  "name",
  "title",
  "description",
  "color",
  "artifact_id",
  "provider",
  "model",
  "thinking_level",
  "section",
  "instructions",
  "expected_version",
] as const;
const FLEET_LIST_ARGS = ["bot_ids", "bot_names", "add_bot_ids", "remove_bot_ids"] as const;
const FLEET_FLAG_ARGS = ["pinned", "clear_section", "clear", "use_attached_image"] as const;

/**
 * Keeps only the fleet and `update_bot` arguments a model sent, coerced to their declared types.
 * Providers send omitted optional fields as null or blank, so those stay absent: `String(null)`
 * would otherwise become the text "null".
 */
export function prepareFleetArguments(
  toolName: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  // A routine's timing fields are numbers and one-of branches; only the blanks are dropped.
  if (toolName === "create_child_routine") {
    return Object.fromEntries(Object.entries(raw).filter(([, value]) => argumentGiven(value)));
  }
  const out: Record<string, unknown> = {};
  for (const key of FLEET_STRING_ARGS) {
    // update_bot never carries instructions; set_child_instructions does, behind a card.
    if (toolName === "update_bot" && (key === "instructions" || key === "expected_version"))
      continue;
    if (argumentGiven(raw[key])) out[key] = String(raw[key]);
  }
  for (const key of FLEET_LIST_ARGS) {
    if (Array.isArray(raw[key])) out[key] = raw[key].map(String);
  }
  for (const key of FLEET_FLAG_ARGS) {
    if (argumentGiven(raw[key])) out[key] = raw[key];
  }
  const notify = raw.notifyOnFinish ?? raw.notify_on_finish;
  if (argumentGiven(notify)) out.notifyOnFinish = notify;
  return out;
}

/** Use a plain string enum: some gateways discard the allowed values from anyOf/const unions. */
function stringEnum(values: readonly string[], options: FieldOptions) {
  return Type.Unsafe<string>({ type: "string", enum: [...values], ...options });
}

/** TypeBox only builds literals from primitives; anything else throws while the tool list is
 * being assembled, which would take down the whole turn. */
function enumUnion(values: readonly unknown[], options: FieldOptions = {}) {
  const members = values.map((value) =>
    value === null
      ? Type.Null()
      : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? Type.Literal(value)
        : undefined,
  );
  return members.every((member) => member !== undefined) ? Type.Union(members, options) : undefined;
}

export function jsonField(spec: unknown): ReturnType<typeof Type.String> {
  const definition = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
  const options = fieldOptions(definition);
  if (Array.isArray(definition.enum) && definition.enum.length > 0) {
    if (definition.enum.every((value) => typeof value === "string")) {
      return stringEnum(definition.enum as string[], options) as never;
    }
    const union = enumUnion(definition.enum, options);
    if (union) return union as never;
  }
  // A `const` names the only accepted value. Without this it degraded to a bare
  // string, so a discriminator like {type: {const: "bearer"}} told the model
  // nothing about which value to send -- and it guessed, twice.
  if ("const" in definition) {
    // Keep `const` (discriminators such as request_secret's auth.type depend on it) and
    // add the equivalent one-value `enum`, which survives converters that drop `const`.
    if (typeof definition.const === "string") {
      return Type.Unsafe<string>({
        type: "string",
        const: definition.const,
        enum: [definition.const],
        ...options,
      }) as never;
    }
    const literal = enumUnion([definition.const], options);
    if (literal) return literal as never;
  }
  // A discriminated union arrives as oneOf/anyOf with no sibling `type`. Without
  // this branch it fell through to the string default, so a model was told to
  // send an object-valued field as a bare string -- which is exactly what it did.
  const variants = Array.isArray(definition.oneOf)
    ? definition.oneOf
    : Array.isArray(definition.anyOf)
      ? definition.anyOf
      : undefined;
  if (variants && variants.length > 0) {
    return Type.Union(
      variants.map((variant) => jsonField(variant)),
      options,
    ) as never;
  }
  if (Array.isArray(definition.type) && definition.type.length > 0) {
    // The description belongs on the union, not repeated on every member.
    const { description: _description, ...member } = definition;
    return Type.Union(
      definition.type.map((type) => jsonField({ ...member, type })),
      options,
    ) as never;
  }
  const type = "type" in definition ? String(definition.type) : "string";
  if (type === "null") return Type.Null(options) as never;
  if (type === "number" || type === "integer") return Type.Number(options) as never;
  if (type === "boolean") return Type.Boolean(options) as never;
  if (type === "array") {
    const arrayOptions: FieldOptions & {
      minItems?: number;
      maxItems?: number;
      uniqueItems?: boolean;
    } = { ...options };
    if (typeof definition.minItems === "number") arrayOptions.minItems = definition.minItems;
    if (typeof definition.maxItems === "number") arrayOptions.maxItems = definition.maxItems;
    if (definition.uniqueItems === true) arrayOptions.uniqueItems = true;
    return Type.Array(jsonField(definition.items), arrayOptions) as never;
  }
  if (type === "object") return jsonSchemaParameters(definition, options) as never;
  return Type.String({
    ...options,
    ...(typeof definition.maxLength === "number" ? { maxLength: definition.maxLength } : {}),
  });
}
