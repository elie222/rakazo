import type {
  BotPackageDocument,
  BotPackageLeftOut,
  BotPackagePreviewInput,
} from "@rakazo/contracts";
import {
  BOT_PACKAGE_FORMAT,
  BOT_PACKAGE_MAX_BYTES,
  BOT_PACKAGE_MAX_CONNECTIONS,
  BOT_PACKAGE_MAX_MEMORY_FILES,
  BOT_PACKAGE_MAX_ROUTINES,
  BOT_PACKAGE_MAX_SKILLS,
  BOT_PACKAGE_MEMORY_MAX_BYTES,
  BotAvatarValueSchema,
  BotPackageDocumentSchema,
  BotPackageRoutineSchema,
  BotPackageSkillSchema,
  botPackageUtf8Bytes,
  TimeZoneSchema,
} from "@rakazo/contracts";
import {
  buildSkillMd,
  hasMixedOneShotSchedule,
  isOneShotRoutineCrons,
  nextCronDateAcrossStrict,
  parseSkillMd,
} from "@rakazo/core";
import { redactSecretText } from "@rakazo/logging";

export class BotPackageError extends Error {}

/** Count only the newly added JSON objects, brackets and separating commas. */
class LeftOutBudget {
  readonly entries: BotPackageLeftOut[] = [];
  private bytes = 2;

  push(...items: BotPackageLeftOut[]): void {
    for (const item of items) {
      const nextBytes =
        this.bytes + (this.entries.length ? 1 : 0) + botPackageUtf8Bytes(JSON.stringify(item));
      if (this.entries.length >= 2000 || nextBytes > 256 * 1024)
        throw new BotPackageError("The package has too many omitted fields to preview safely.");
      this.entries.push(item);
      this.bytes = nextBytes;
    }
  }
}

type RecordValue = Record<string, unknown>;
export type ParsedBotPackage = {
  document: BotPackageDocument;
  json: string;
  sourceFormat: typeof BOT_PACKAGE_FORMAT | "openmaus.grok/1" | "grokbot-bundle/v1";
  leftOut: BotPackageLeftOut[];
  availableMemoryCount: number;
};
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (...values: unknown[]): string =>
  values.find((value): value is string => typeof value === "string" && value.trim().length > 0) ??
  "";
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const known = (value: unknown): RecordValue => (record(value) ? value : {});

function guardStructure(root: unknown) {
  const stack = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    if (++nodes > 100_000 || item.depth > 32)
      throw new BotPackageError("Package structure is too complex.");
    if (typeof item.value === "string" && item.value.includes("\0"))
      throw new BotPackageError("Package text cannot contain NUL characters.");
    const values = Array.isArray(item.value)
      ? item.value
      : record(item.value)
        ? Object.values(item.value)
        : [];
    if (values.length + stack.length + nodes > 100_000)
      throw new BotPackageError("Package structure is too complex.");
    for (const value of values) stack.push({ value, depth: item.depth + 1 });
  }
}

function sourceObject(source: string): RecordValue {
  if (botPackageUtf8Bytes(source) > BOT_PACKAGE_MAX_BYTES)
    throw new BotPackageError("Package is larger than 4 MiB.");
  const raw = source.replace(/^\uFEFF/, "").trim();
  if (/^(?:https?:\/\/|grokbot:)/i.test(raw))
    throw new BotPackageError(
      "A public share link does not contain the setup. Paste a JSON export.",
    );
  const candidates = [raw];
  for (const match of raw.matchAll(/```(?:json)?([\s\S]*?)```/gi)) {
    candidates.push((match[1] ?? "").trimStart());
    if (candidates.length >= 10) break;
  }
  const open = raw.indexOf("{");
  const close = raw.lastIndexOf("}");
  if (open >= 0 && close > open) candidates.push(raw.slice(open, close + 1));
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (record(value)) {
      guardStructure(value);
      return value;
    }
  }
  throw new BotPackageError("Paste a supported JSON package or bot export.");
}

function limitedArray(value: unknown, limit: number, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BotPackageError(`${field} must be a list.`);
  if (value.length > limit) throw new BotPackageError(`${field} has too many entries.`);
  return value;
}

const EVENT_WORDS =
  /\b(?:when|whenever|each time|every time|on (?:new|each|every)|webhook|mention(?:ed|s)?|incoming|arrives?|opens?|merged?|pushed?)\b/i;
const looksLikeCron = (value: string) => {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.slice(0, 2).every((field) => /^[\d*/,-]+$/.test(field));
};
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function dailyCron(schedule: string): string | null {
  const lower = schedule.toLowerCase();
  if (
    EVENT_WORDS.test(lower) ||
    /\b(?:hour|hourly|minute|minutes|month|monthly|year)\b/.test(lower)
  )
    return null;
  const clock =
    lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/) ??
    lower.match(/\b(\d{1,2}):(\d{2})\b/) ??
    lower.match(/\bat (\d{1,2})\b/);
  let hour: number;
  let minute = 0;
  if (/\bnoon\b/.test(lower)) hour = 12;
  else if (/\bmidnight\b/.test(lower)) hour = 0;
  else if (clock) {
    hour = Number(clock[1]);
    minute = Number(clock[2] ?? 0);
    if (clock[3]) {
      if (hour < 1 || hour > 12) return null;
      if (clock[3].startsWith("p") && hour < 12) hour += 12;
      if (clock[3].startsWith("a") && hour === 12) hour = 0;
    }
  } else return null;
  if (hour > 23 || minute > 59) return null;
  let days: number[];
  if (
    /\bweekdays?\b|\bmon(?:day)?s?\s*(?:-|–|to|through)\s*fri(?:day)?\b|\bbusiness days?\b|\bworkdays?\b/.test(
      lower,
    )
  )
    days = [1, 2, 3, 4, 5];
  else if (/\bweekends?\b/.test(lower)) days = [0, 6];
  else if (
    /\b(?:daily|every ?day|each day|every (?:morning|evening|night|afternoon))\b/.test(lower)
  )
    days = [0, 1, 2, 3, 4, 5, 6];
  else
    days = WEEKDAYS.flatMap((day, index) =>
      new RegExp(`\\b${day}(?:[a-z]*day)?s?\\b`).test(lower) ? [index] : [],
    );
  return days.length ? `${minute} ${hour} * * ${days.length === 7 ? "*" : days.join(",")}` : null;
}

function validateRoutine(routine: BotPackageDocument["routines"][number]) {
  if (hasMixedOneShotSchedule(routine.crons))
    throw new BotPackageError("A one-shot schedule cannot be mixed with recurring schedules.");
  try {
    nextCronDateAcrossStrict(routine.crons, new Date("2026-01-01T00:00:00Z"), routine.timezone);
  } catch {
    throw new BotPackageError("A routine schedule is invalid.");
  }
}

function convertGrok(root: RecordValue, leftOut: LeftOutBudget, defaultTimezone: string): unknown {
  const persona = known(root.persona);
  const bundle = root.format === "grokbot-bundle/v1";
  const instructions = text(
    root.instructions,
    root.soul,
    root.systemPrompt,
    persona.instructions,
    persona.description,
  );
  const name =
    text(root.name, persona.name, root.botName).trim() || (instructions ? "Grok Bot" : "");
  if (!name) throw new BotPackageError("The export has no bot name or instructions.");
  if (!instructions)
    leftOut.push({
      kind: "instructions",
      name: "profile.instructions",
      reason: "The export did not include private standing instructions.",
    });
  const skills = limitedArray(root.skills, BOT_PACKAGE_MAX_SKILLS, "Skills").flatMap(
    (value, index) => {
      const entry = typeof value === "string" ? { name: value } : known(value);
      const body = text(entry.body, entry.instructions, entry.content, entry.text);
      if (!body) {
        leftOut.push({
          kind: "skill",
          name: `skills[${index}]`,
          reason: "No self-contained skill text was provided.",
        });
        return [];
      }
      const parsed = parseSkillMd(body);
      if (!("error" in parsed)) {
        const validated = BotPackageSkillSchema.safeParse({
          name: parsed.name,
          description: parsed.description,
          content: body,
        });
        if (validated.success) return [validated.data];
        leftOut.push({
          kind: "skill",
          name: `skills[${index}]`,
          reason: "The skill did not fit the supported field limits.",
        });
        return [];
      }
      const skillName = text(entry.name, entry.title).trim() || `skill-${index + 1}`;
      const description =
        text(entry.description, entry.summary).trim() ||
        body
          .split(/\r?\n/)
          .find((line) => line.trim())
          ?.slice(0, 2000) ||
        "Imported skill";
      let content: string;
      try {
        content = buildSkillMd({ name: skillName, description, body });
      } catch {
        leftOut.push({
          kind: "skill",
          name: `skills[${index}]`,
          reason: "The skill text could not be read.",
        });
        return [];
      }
      const result = BotPackageSkillSchema.safeParse({ name: skillName, description, content });
      if (!result.success) {
        leftOut.push({
          kind: "skill",
          name: `skills[${index}]`,
          reason: "The skill did not fit the supported field limits.",
        });
        return [];
      }
      return [result.data];
    },
  );
  const routines = limitedArray(root.routines, BOT_PACKAGE_MAX_ROUTINES, "Routines").flatMap(
    (value, index) => {
      const entry = known(value);
      const prompt = text(entry.prompt, entry.instructions, entry.task);
      const schedule = text(entry.schedule, entry.when, entry.trigger, entry.triggerSummary);
      const cron =
        text(entry.cron, entry.cronExpression).trim() ||
        (looksLikeCron(schedule) ? schedule.trim() : dailyCron(schedule));
      if (!prompt || !cron) {
        leftOut.push({
          kind: "routine",
          name: `routines[${index}]`,
          reason: !prompt
            ? "No routine instructions were provided."
            : "Event or unrecognized schedules need manual setup.",
        });
        return [];
      }
      const zone = text(entry.timeZone, entry.timezone, entry.tz).trim() || defaultTimezone;
      const timezone = TimeZoneSchema.safeParse(zone).success ? zone : defaultTimezone;
      if (timezone !== zone)
        leftOut.push({
          kind: "routine",
          name: `routines[${index}].timezone`,
          reason: "The unrecognized timezone was replaced with the account timezone.",
        });
      const result = BotPackageRoutineSchema.safeParse({
        name: text(entry.name, entry.title).trim() || `Routine ${index + 1}`,
        prompt,
        crons: [cron],
        timezone,
      });
      if (!result.success) {
        leftOut.push({
          kind: "routine",
          name: `routines[${index}]`,
          reason: "The routine did not fit the supported field limits.",
        });
        return [];
      }
      if (isOneShotRoutineCrons(result.data.crons)) {
        leftOut.push({
          kind: "routine",
          name: `routines[${index}]`,
          reason: "One-shot schedules need manual setup.",
        });
        return [];
      }
      try {
        validateRoutine(result.data);
      } catch {
        const fallback = dailyCron(schedule);
        if (fallback && fallback !== cron) {
          try {
            const recovered = { ...result.data, crons: [fallback] };
            validateRoutine(recovered);
            return [recovered];
          } catch {
            /* The plain clock also needs manual setup. */
          }
        }
        leftOut.push({
          kind: "routine",
          name: `routines[${index}]`,
          reason: "The schedule could not be read.",
        });
        return [];
      }
      return [result.data];
    },
  );
  const connections = limitedArray(
    root.plugins ?? root.apps ?? root.integrations,
    BOT_PACKAGE_MAX_CONNECTIONS,
    "Connection requirements",
  ).flatMap((value, index) => {
    const entry = known(value);
    const label = typeof value === "string" ? value.trim() : text(entry.name, entry.label).trim();
    if (!label)
      leftOut.push({
        kind: "connection",
        name: `connections[${index}]`,
        reason: "No connection name was provided.",
      });
    return label ? [{ name: label, note: text(entry.note, entry.reason, entry.description) }] : [];
  });
  const memories = limitedArray(root.memories, BOT_PACKAGE_MAX_MEMORY_FILES, "Memory notes")
    .map((value) =>
      typeof value === "string" ? value : text(known(value).text, known(value).content),
    )
    .filter((value) => value.length > 0);
  const color = BotAvatarValueSchema.safeParse(
    text(root.color, persona.avatarColor, known(root.source).color),
  );
  const description =
    text(root.description, persona.description === instructions ? "" : persona.description) ||
    (bundle ? (instructions.split(/\n\s*\n/)[0] ?? "").slice(0, 300) : "");
  return {
    format: BOT_PACKAGE_FORMAT,
    profile: {
      name,
      title: text(root.title, persona.title),
      description,
      instructions,
      ...(color.success ? { color: color.data } : {}),
    },
    skills,
    routines,
    connections,
    memory: memories.map((content, index) => ({
      path: index === 0 ? "MEMORY.md" : `memory/import-${index + 1}.md`,
      content,
    })),
  };
}

function ignoredFields(
  root: RecordValue,
  allowed: Set<string>,
  path: string,
  leftOut: LeftOutBudget,
) {
  const ignored = Object.keys(root).filter((key) => !allowed.has(key));
  for (const [index, key] of ignored.entries()) {
    // Never show a truncated credential prefix: an oversized name is omitted whole.
    const oversized = key.length > 100;
    const label = oversized
      ? `[field ${index + 1}]`
      : redactSecretText(key)
          .replace(/\p{Cc}/gu, " ")
          .slice(0, 100);
    leftOut.push({
      kind:
        !oversized && /secret|password|credential|token|oauth|totp/i.test(key)
          ? "secrets"
          : "unsupported",
      name: `${path}.${label}`,
      reason: oversized
        ? "This configuration field is not imported; its name exceeds the preview limit."
        : "This configuration field is not imported.",
    });
  }
}

function guardCollections(value: unknown) {
  const root = known(value);
  limitedArray(root.skills, BOT_PACKAGE_MAX_SKILLS, "Skills");
  const routines = limitedArray(root.routines, BOT_PACKAGE_MAX_ROUTINES, "Routines");
  limitedArray(root.connections, BOT_PACKAGE_MAX_CONNECTIONS, "Connection requirements");
  limitedArray(root.memory, BOT_PACKAGE_MAX_MEMORY_FILES, "Memory notes");
  for (const routine of routines) limitedArray(known(routine).crons, 50, "Routine schedules");
}

function redactDocument(document: BotPackageDocument, leftOut: LeftOutBudget): BotPackageDocument {
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      const cleaned = redactSecretText(value);
      if (cleaned !== value)
        leftOut.push({
          kind: "secrets",
          name: path,
          reason: "Recognized credential text was removed.",
        });
      return cleaned;
    }
    if (Array.isArray(value)) return value.map((entry, index) => walk(entry, `${path}[${index}]`));
    if (record(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          walk(entry, path ? `${path}.${key}` : key),
        ]),
      );
    return value;
  };
  // The format discriminator is a protocol identifier rather than portable text.
  const cleaned = walk(document, "") as RecordValue;
  cleaned.format = BOT_PACKAGE_FORMAT;
  const parsed = BotPackageDocumentSchema.safeParse(cleaned);
  if (!parsed.success)
    throw new BotPackageError(
      "The package could not be represented safely. Review its fields and limits.",
    );
  return parsed.data;
}

/** Stable serialization of the normalized, bounded portable document. */
export function canonicalBotPackageJson(value: BotPackageDocument): string {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input !== "object") return JSON.stringify(input) ?? "null";
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    const object = input as RecordValue;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  };
  const json = canonical(value);
  if (botPackageUtf8Bytes(json) > BOT_PACKAGE_MAX_BYTES)
    throw new BotPackageError("Package is larger than 4 MiB.");
  return json;
}

export function prepareBotPackageDocument(value: unknown): {
  document: BotPackageDocument;
  json: string;
  leftOut: BotPackageLeftOut[];
} {
  guardStructure(value);
  guardCollections(value);
  const parsed = BotPackageDocumentSchema.safeParse(value);
  if (!parsed.success)
    throw new BotPackageError("The package has unsupported or oversized fields.");
  const leftOut = new LeftOutBudget();
  const document = redactDocument(parsed.data, leftOut);
  const seenPaths = new Set<string>();
  let memoryBytes = 0;
  for (const note of document.memory) {
    if (seenPaths.has(note.path)) throw new BotPackageError("Memory note paths must be distinct.");
    seenPaths.add(note.path);
    memoryBytes += botPackageUtf8Bytes(note.content);
  }
  if (memoryBytes > BOT_PACKAGE_MEMORY_MAX_BYTES)
    throw new BotPackageError("Memory notes are larger than 1 MiB.");
  for (const skill of document.skills) {
    const content = parseSkillMd(skill.content);
    if (
      "error" in content ||
      content.name !== skill.name ||
      content.description !== skill.description
    )
      throw new BotPackageError("Skill metadata must match its self-contained SKILL.md text.");
  }
  for (const routine of document.routines) validateRoutine(routine);
  const json = canonicalBotPackageJson(document);
  return { document, json, leftOut: leftOut.entries };
}

export function parseBotPackageSource(
  source: string,
  options: Pick<BotPackagePreviewInput, "name" | "includeMemory"> & { defaultTimezone?: string },
): ParsedBotPackage {
  const root = sourceObject(source);
  const format = root.format;
  if (
    format !== BOT_PACKAGE_FORMAT &&
    format !== "openmaus.grok/1" &&
    format !== "grokbot-bundle/v1"
  )
    throw new BotPackageError("This JSON format is not supported.");
  const leftOut = new LeftOutBudget();
  const zone = TimeZoneSchema.safeParse(options.defaultTimezone ?? "UTC");
  const candidate =
    format === BOT_PACKAGE_FORMAT
      ? root
      : convertGrok(root, leftOut, zone.success ? zone.data : "UTC");
  const native = known(candidate);
  ignoredFields(
    root,
    new Set(
      format === BOT_PACKAGE_FORMAT
        ? ["format", "profile", "skills", "routines", "connections", "memory"]
        : [
            "format",
            "name",
            "title",
            "description",
            "instructions",
            "soul",
            "systemPrompt",
            "persona",
            "botName",
            "creator",
            "author",
            "source",
            "url",
            "sourceUrl",
            "color",
            "skills",
            "routines",
            "plugins",
            "apps",
            "integrations",
            "memories",
          ],
    ),
    "package",
    leftOut,
  );
  ignoredFields(
    known(native.profile),
    new Set(["name", "title", "description", "instructions", "color"]),
    "profile",
    leftOut,
  );
  for (const [index, skill] of list(native.skills).entries())
    ignoredFields(
      known(skill),
      new Set(["name", "description", "content"]),
      `skills[${index}]`,
      leftOut,
    );
  for (const [index, routine] of list(native.routines).entries())
    ignoredFields(
      known(routine),
      new Set(["name", "prompt", "crons", "timezone"]),
      `routines[${index}]`,
      leftOut,
    );
  for (const [index, connection] of list(native.connections).entries())
    ignoredFields(known(connection), new Set(["name", "note"]), `connections[${index}]`, leftOut);
  for (const [index, memory] of list(native.memory).entries())
    ignoredFields(known(memory), new Set(["path", "content"]), `memory[${index}]`, leftOut);
  if (format !== BOT_PACKAGE_FORMAT) {
    ignoredFields(
      known(root.persona),
      new Set(["name", "title", "description", "instructions", "avatarColor"]),
      "persona",
      leftOut,
    );
    for (const key of ["creator", "author", "source", "url", "sourceUrl"])
      if (root[key] !== undefined)
        leftOut.push({
          kind: "unsupported",
          name: key,
          reason: "Source identities and links are not bound to the new Bot.",
        });
    for (const [index, skill] of list(root.skills).entries())
      ignoredFields(
        known(skill),
        new Set([
          "name",
          "title",
          "description",
          "summary",
          "body",
          "instructions",
          "content",
          "text",
        ]),
        `skills[${index}]`,
        leftOut,
      );
    for (const [index, routine] of list(root.routines).entries())
      ignoredFields(
        known(routine),
        new Set([
          "name",
          "title",
          "schedule",
          "when",
          "trigger",
          "triggerSummary",
          "cron",
          "cronExpression",
          "timeZone",
          "timezone",
          "tz",
          "prompt",
          "instructions",
          "task",
        ]),
        `routines[${index}]`,
        leftOut,
      );
    for (const [index, connection] of list(
      root.plugins ?? root.apps ?? root.integrations,
    ).entries())
      ignoredFields(
        known(connection),
        new Set(["name", "label", "note", "reason", "description"]),
        `connections[${index}]`,
        leftOut,
      );
    for (const [index, memory] of list(root.memories).entries())
      ignoredFields(known(memory), new Set(["text", "content"]), `memory[${index}]`, leftOut);
  }
  guardCollections(native);
  if (format === BOT_PACKAGE_FORMAT && Array.isArray(native.routines))
    native.routines = native.routines.filter((value, index) => {
      const crons = known(value).crons;
      if (
        Array.isArray(crons) &&
        (crons.length === 0 ||
          (crons.every((cron) => typeof cron === "string") && isOneShotRoutineCrons(crons)))
      ) {
        leftOut.push({
          kind: "routine",
          name: `routines[${index}]`,
          reason: "Event or one-shot schedules need manual setup.",
        });
        return false;
      }
      return true;
    });
  if (options.name) native.profile = { ...known(native.profile), name: options.name };
  const safe = prepareBotPackageDocument(native);
  leftOut.push(...safe.leftOut);
  const document = safe.document;
  let json = safe.json;
  const availableMemoryCount = document.memory.length;
  if (!options.includeMemory && availableMemoryCount) {
    leftOut.push({
      kind: "memory",
      name: "memory",
      reason: `Memory notes not selected: ${availableMemoryCount}.`,
    });
    document.memory = [];
    json = canonicalBotPackageJson(document);
  }
  return { document, json, sourceFormat: format, leftOut: leftOut.entries, availableMemoryCount };
}
