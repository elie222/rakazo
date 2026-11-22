import { isRecord } from "@rakazo/core";
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
  if (!rootUnionKey(schema)) return schema;
  const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...rest } = schema;
  const requiredOf = (source: Record<string, unknown>) =>
    Array.isArray(source.required) ? source.required.map(String) : [];
  const mergeProperties = (sources: Record<string, unknown>[], combinator: "allOf" | "anyOf") => {
    const specs = new Map<string, { items: unknown[]; keys: Set<string> }>();
    for (const source of sources) {
      if (!isRecord(source.properties)) continue;
      for (const [name, spec] of Object.entries(source.properties)) {
        let entry = specs.get(name);
        if (!entry) {
          entry = { items: [], keys: new Set() };
          specs.set(name, entry);
        }
        const key = JSON.stringify(spec) ?? "undefined";
        if (!entry.keys.has(key)) {
          entry.keys.add(key);
          entry.items.push(spec);
        }
      }
    }
    return Object.fromEntries(
      [...specs].map(([name, { items }]) => {
        if (items.length === 1) return [name, items[0]];
        if (combinator === "anyOf") {
          const compacted = compactAnyOf(items);
          return [name, compacted.length === 1 ? compacted[0] : { anyOf: compacted }];
        }
        return [name, { [combinator]: items }];
      }),
    );
  };

  const groups = (["allOf", "anyOf", "oneOf"] as const).flatMap((key) => {
    if (!Array.isArray(schema[key])) return [];
    const variants = schema[key]
      .map((variant) => (variant === true ? {} : variant))
      .filter(isRecord)
      .map((variant) => flattenRootUnion(variant, root, references));
    const variantRequired = variants.map(requiredOf);
    const required =
      key === "allOf"
        ? variantRequired.flat()
        : (variantRequired[0] ?? []).filter((name) =>
            variantRequired.every((items) => items.includes(name)),
          );
    return [
      {
        key,
        variants,
        hasTrueAlternative: key !== "allOf" && schema[key].includes(true),
        properties: mergeProperties(variants, key === "allOf" ? "allOf" : "anyOf"),
        required,
        ...(variants.length > 0 &&
        variants.every(
          (variant) => variant.additionalProperties === false && variant.patternProperties == null,
        )
          ? { additionalProperties: false }
          : {}),
      },
    ];
  });
  const siblingProperties = [rest, ...groups].map((source) =>
    isRecord(source.properties) ? new Set(Object.keys(source.properties)) : new Set<string>(),
  );
  for (const [index, group] of groups.entries()) {
    if (group.key === "allOf") continue;
    for (const name of Object.keys(group.properties)) {
      const hasSibling = siblingProperties.some((names, i) => i !== index + 1 && names.has(name));
      if (group.hasTrueAlternative) {
        if (hasSibling) delete group.properties[name];
        else group.properties[name] = {};
        continue;
      }
      if (!hasSibling) {
        continue;
      }
      const missing = group.variants.filter(
        (variant) => !isRecord(variant.properties) || !Object.hasOwn(variant.properties, name),
      );
      for (const variant of missing) {
        // A closed alternative without patterns cannot accept this property. An open
        // alternative permits it, so don't intersect with constraints from other
        // alternatives when a sibling already supplies the property's schema.
        if (variant.patternProperties == null && variant.additionalProperties === false) continue;
        if (variant.patternProperties == null && isRecord(variant.additionalProperties)) {
          group.properties[name] = {
            anyOf: [group.properties[name], variant.additionalProperties],
          };
        } else {
          delete group.properties[name];
          break;
        }
      }
    }
  }
  const sources = [rest, ...groups];
  const properties = mergeProperties(sources, "allOf");
  for (const names of siblingProperties) {
    for (const name of names) {
      if (!Object.hasOwn(properties, name)) properties[name] = {};
    }
  }
  const required = [...new Set(sources.flatMap(requiredOf))];
  const closed = sources.some((source) => source.additionalProperties === false);
  return {
    ...rest,
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(closed ? { additionalProperties: false } : {}),
  };
}

/** Resolve only same-document JSON pointers; never fetch external schemas. */
export function localSchemaReference(root: Record<string, unknown>, ref: string): unknown {
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

const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);
const ALL_JSON_SCHEMA_TYPES = new Set([...PRIMITIVE_TYPES, "object", "array"]);
const SCHEMA_ANNOTATION_KEYS = new Set(["description", "title"]);
const COMPLEX_SCHEMA_KEYS = [
  "anyOf",
  "oneOf",
  "allOf",
  "$ref",
  "const",
  "enum",
  "not",
  "if",
] as const;

function isPureNonEmptyAnyOf(
  spec: unknown,
): spec is Record<string, unknown> & { anyOf: unknown[] } {
  return (
    isRecord(spec) &&
    Array.isArray(spec.anyOf) &&
    spec.anyOf.length > 0 &&
    Object.keys(spec).length === 1
  );
}

function isUnconstrainedPrimitive(
  spec: unknown,
): spec is Record<string, unknown> & { type: string } {
  if (!isRecord(spec) || typeof spec.type !== "string" || !PRIMITIVE_TYPES.has(spec.type)) {
    return false;
  }
  return Object.keys(spec).every((key) => key === "type" || SCHEMA_ANNOTATION_KEYS.has(key));
}

function isSimpleConstrainedPrimitive(
  spec: unknown,
): spec is Record<string, unknown> & { type: string } {
  return (
    isRecord(spec) &&
    typeof spec.type === "string" &&
    PRIMITIVE_TYPES.has(spec.type) &&
    COMPLEX_SCHEMA_KEYS.every((key) => !(key in spec))
  );
}

function isPatternOnlyString(spec: unknown): spec is Record<string, unknown> & { type: string } {
  return (
    isRecord(spec) &&
    spec.type === "string" &&
    typeof spec.pattern === "string" &&
    Object.keys(spec).length === 2
  );
}

function isSimpleStringSchema(spec: unknown): boolean {
  if (
    !isRecord(spec) ||
    spec.type !== "string" ||
    "anyOf" in spec ||
    "oneOf" in spec ||
    "allOf" in spec ||
    "$ref" in spec
  ) {
    return false;
  }
  if ("const" in spec && typeof spec.const !== "string") return false;
  if (
    "enum" in spec &&
    (!Array.isArray(spec.enum) || !spec.enum.every((value) => typeof value === "string"))
  ) {
    return false;
  }
  return true;
}

function typesOverlap(a: string, b: string): boolean {
  return a === b || (a === "number" && b === "integer") || (a === "integer" && b === "number");
}

function schemaCanAcceptType(spec: unknown, targetType: string): boolean {
  if (spec === false) return false;
  if (!isRecord(spec) || typeof spec.$ref === "string") return true;
  if (typeof spec.type === "string") {
    return !ALL_JSON_SCHEMA_TYPES.has(spec.type) || typesOverlap(spec.type, targetType);
  }
  if (Array.isArray(spec.type)) {
    return spec.type.some(
      (type) =>
        typeof type !== "string" ||
        !ALL_JSON_SCHEMA_TYPES.has(type) ||
        typesOverlap(type, targetType),
    );
  }
  return true;
}

/**
 * Flatten single-level pure `anyOf` branches when coercion-equivalent, deduplicate in linear time,
 * and compact redundant primitive/pattern branches without shifting validator coercion precedence.
 */
function compactAnyOf(members: unknown[]): unknown[] {
  type PreparedEntry =
    | { isUnion: false; member: unknown }
    | { isUnion: true; member: unknown; branches: unknown[]; branchKeys: string[] };

  const prepared: PreparedEntry[] = members.map((member) => {
    if (!isPureNonEmptyAnyOf(member)) return { isUnion: false, member };
    const branches = member.anyOf;
    const branchKeys = branches.map((branch) => JSON.stringify(branch) ?? "undefined");
    return { isUnion: true, member, branches, branchKeys };
  });

  let largestUnionBranches: Set<string> | undefined;
  const active: PreparedEntry[] = [];
  for (const entry of prepared) {
    if (entry.isUnion) {
      if (largestUnionBranches && entry.branchKeys.every((key) => largestUnionBranches!.has(key))) {
        continue;
      }
      if (!largestUnionBranches || entry.branchKeys.length > largestUnionBranches.size) {
        largestUnionBranches = new Set(entry.branchKeys);
      }
    }
    active.push(entry);
  }
  if (active.length === 1) return [active[0]!.member];

  const acceptsPerEntry: Set<string>[] = active.map((entry) => {
    const accepts = new Set<string>();
    for (const type of PRIMITIVE_TYPES) {
      const matches = entry.isUnion
        ? entry.branches.some((branch) => schemaCanAcceptType(branch, type))
        : schemaCanAcceptType(entry.member, type);
      if (matches) accepts.add(type);
    }
    return accepts;
  });
  const totalAccepts = new Map<string, number>();
  for (const accepts of acceptsPerEntry) {
    for (const type of accepts) {
      totalAccepts.set(type, (totalAccepts.get(type) ?? 0) + 1);
    }
  }

  const flatItems: { spec: unknown; key?: string }[] = [];
  const earlierUnconstrained = new Set<string>();
  let precedingStringCount = 0;
  let allPrecedingStringsSimple = true;
  for (let i = 0; i < active.length; i += 1) {
    const entry = active[i]!;
    const selfAccepts = acceptsPerEntry[i]!;
    if (!entry.isUnion) {
      flatItems.push({ spec: entry.member });
      if (isUnconstrainedPrimitive(entry.member)) {
        earlierUnconstrained.add(entry.member.type);
      }
      if (selfAccepts.has("string")) {
        allPrecedingStringsSimple &&= isSimpleStringSchema(entry.member);
        precedingStringCount += 1;
      }
      continue;
    }

    const withinUnionUnconstrained = new Set<string>();
    let canUnwrap = true;
    for (let branchIndex = 0; branchIndex < entry.branches.length; branchIndex += 1) {
      const branch = entry.branches[branchIndex];
      if (isUnconstrainedPrimitive(branch)) {
        withinUnionUnconstrained.add(branch.type);
        continue;
      }
      if (!isSimpleConstrainedPrimitive(branch)) {
        canUnwrap = false;
        break;
      }
      const othersAccepting =
        (totalAccepts.get(branch.type) ?? 0) - (selfAccepts.has(branch.type) ? 1 : 0);
      const coveredEarlier =
        earlierUnconstrained.has(branch.type) || withinUnionUnconstrained.has(branch.type);
      const precededOnlyBySimpleStrings =
        branch.type === "string" &&
        othersAccepting === precedingStringCount &&
        allPrecedingStringsSimple;
      const trailingSimpleString =
        branch.type === "string" &&
        branchIndex === entry.branches.length - 1 &&
        othersAccepting === 1 &&
        i + 1 < active.length &&
        acceptsPerEntry[i + 1]!.has("string") &&
        isSimpleStringSchema(active[i + 1]!.member);
      if (
        !coveredEarlier &&
        othersAccepting !== 0 &&
        !precededOnlyBySimpleStrings &&
        !trailingSimpleString
      ) {
        canUnwrap = false;
        break;
      }
    }

    if (!canUnwrap) {
      flatItems.push({ spec: entry.member });
      if (selfAccepts.has("string")) {
        allPrecedingStringsSimple = false;
        precedingStringCount += 1;
      }
      continue;
    }

    for (let branchIndex = 0; branchIndex < entry.branches.length; branchIndex += 1) {
      const branch = entry.branches[branchIndex];
      flatItems.push({ spec: branch, key: entry.branchKeys[branchIndex] });
      if (isUnconstrainedPrimitive(branch)) {
        earlierUnconstrained.add(branch.type);
      }
    }
    if (selfAccepts.has("string")) {
      allPrecedingStringsSimple &&= entry.branches.every(
        (branch) => !schemaCanAcceptType(branch, "string") || isSimpleStringSchema(branch),
      );
      precedingStringCount += 1;
    }
  }

  const seenKeys = new Set<string>();
  const deduped: unknown[] = [];
  for (const item of flatItems) {
    const key = item.key ?? JSON.stringify(item.spec) ?? "undefined";
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(item.spec);
  }

  const promoted: unknown[] = [];
  const firstUnconstrainedIndex = new Map<string, number>();
  const firstIsBare = new Set<string>();
  for (const member of deduped) {
    if (!isUnconstrainedPrimitive(member)) {
      promoted.push(member);
      continue;
    }
    const type = member.type;
    const bare = Object.keys(member).length === 1;
    const firstIndex = firstUnconstrainedIndex.get(type);
    if (firstIndex === undefined) {
      firstUnconstrainedIndex.set(type, promoted.length);
      if (bare) firstIsBare.add(type);
      promoted.push(member);
      continue;
    }
    if (bare) continue;
    if (firstIsBare.has(type)) {
      promoted[firstIndex] = member;
      firstIsBare.delete(type);
      continue;
    }
    promoted.push(member);
  }

  const seenUnconstrainedString = new Array<boolean>(promoted.length).fill(false);
  let hasUnconstrainedStringBefore = false;
  for (let i = 0; i < promoted.length; i += 1) {
    seenUnconstrainedString[i] = hasUnconstrainedStringBefore;
    const member = promoted[i];
    if (isUnconstrainedPrimitive(member) && member.type === "string") {
      hasUnconstrainedStringBefore = true;
    }
  }

  const keep = new Array<boolean>(promoted.length).fill(true);
  let stringDirectlyAhead = false;
  for (let i = promoted.length - 1; i >= 0; i -= 1) {
    const member = promoted[i];
    if (isUnconstrainedPrimitive(member) && member.type === "string") {
      stringDirectlyAhead = true;
      continue;
    }
    if (isPatternOnlyString(member)) {
      if (seenUnconstrainedString[i] || stringDirectlyAhead) {
        keep[i] = false;
      }
      continue;
    }
    stringDirectlyAhead = false;
  }

  return promoted.filter((_, i) => keep[i]);
}
