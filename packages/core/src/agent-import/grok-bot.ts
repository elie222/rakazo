// Reads the grok-bot-export v1 document a Grok Bot writes about itself. The export prompt,
// reply repairs and export reading adapt OpenMausBot (Apache-2.0), which adapts Hermes'
// agent-importers plugin (MIT); see NOTICE. Exports written for either import here.
import type { AgentImportMemory, AgentImportSkill } from "@rakazo/contracts";
import {
  AGENT_IMPORT_MAX_TOTAL_LENGTH,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
} from "@rakazo/contracts";
import JSON5 from "json5";
import { buildSkillMd, parseSkillMd } from "../agent-skill.js";
import { nextCronDateAcrossStrict } from "../cron.js";
import type { AgentImportParse } from "./shared.js";
import { freeName, memoryItem, renameSkillMd, skillItem } from "./shared.js";

export const GROK_BOT_EXPORT_FORMAT = "grok-bot-export";
/** Raw pasted reply or chosen files, before one Bot is picked. */
export const GROK_BOT_REPLY_MAX_LENGTH = AGENT_IMPORT_MAX_TOTAL_LENGTH;
export const GROK_BOT_ROUTINES_PATH = "grok-bot-routines.md";

/**
 * Grok Bot has no export button, so each Bot writes its own setup. Model-facing text pasted
 * into another product, so it stays in English. Keep its fields in sync with `readBot`.
 */
export const GROK_BOT_EXPORT_PROMPT = `I am moving you to another assistant app and need a complete, machine-readable copy of your setup. Do not change, pause or delete anything.

Write one JSON document in exactly this shape. Save it as grok-bot-export-<your name>.json (lowercase, spaces as hyphens) and attach it to your reply. If you cannot attach files, reply with the whole document in a single \`\`\`json code block.

{
  "format": "${GROK_BOT_EXPORT_FORMAT}",
  "version": 1,
  "bots": [
    {
      "name": "your name",
      "title": "your job title, or empty",
      "description": "one line about what you do, or empty",
      "instructions": "your full role, job description and standing rules, word for word where you can",
      "memories": ["one thing you remember about the work per string"],
      "user_facts": ["one fact you know about me (name, time zone, preferences) per string"],
      "skills": [
        {"name": "skill name", "description": "when to use it",
         "instructions": "the COMPLETE skill text: every step, rule and output format, word for word"}
      ],
      "routines": [
        {"name": "routine name",
         "instruction": "the COMPLETE instruction the routine runs, word for word",
         "trigger": "schedule | slack | github | linear | sentry | pagerduty | email | webhook | other",
         "schedule_cron": "5-field cron in the routine's time zone, e.g. 0 8 * * 1-5 (empty when not on a schedule)",
         "schedule_text": "when it runs, in words",
         "timezone": "IANA time zone, e.g. America/New_York",
         "skills": ["names of skills this routine uses"],
         "trigger_details": "for other triggers: channel, repository, phrase, senders and so on"}
      ],
      "apps": [{"name": "connected app or MCP server", "mcp_url": "its remote MCP URL, or empty"}]
    }
  ]
}

Rules:
- Include every routine you own, paused ones too, and every skill enabled for you, with full text rather than summaries.
- If you cannot read something, leave it out and tell me what you left out. Never guess or fill it in from memory.
- Never include passwords, API keys, tokens, webhook secrets, cookies or card numbers.
- Output valid JSON only, with no comments.
- If it is too long for one message or file, split it into several documents of this same shape with the same bot name, each holding a part the others do not.
`;

export type GrokBotExportErrorCode = "not_export" | "cut_off" | "too_large" | "newer_version";

export class GrokBotExportError extends Error {
  readonly code: GrokBotExportErrorCode;
  constructor(code: GrokBotExportErrorCode) {
    super(code);
    this.name = "GrokBotExportError";
    this.code = code;
  }
}

export type GrokBotSkill = { name: string; description: string; instructions: string };
export type GrokBotRoutine = {
  name: string;
  instruction: string;
  trigger: string;
  cron: string;
  when: string;
  timeZone: string;
  skills: string[];
  details: string;
};
export type GrokBotApp = { name: string; mcpUrl: string; transport: string; headerNames: string[] };
export type GrokBot = {
  name: string;
  title: string;
  description: string;
  instructions: string;
  memories: string[];
  userFacts: string[];
  skills: GrokBotSkill[];
  routines: GrokBotRoutine[];
  apps: GrokBotApp[];
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string =>
  typeof value === "string"
    ? value.trim()
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : "";
const first = (...values: unknown[]) => values.map(text).find(Boolean) ?? "";
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown) =>
  list(value)
    .map((item) => (isObject(item) ? first(item.text, item.content, item.name) : text(item)))
    .filter(Boolean);

/** Control and line-separator characters become spaces; whitespace collapses. */
function oneLine(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    out += control || code === 0x2028 || code === 0x2029 ? " " : char;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Failed brace matches before a reply stops being searched: each one scans to its end. */
const MAX_UNBALANCED = 50;
const BOT_FIELDS = ["instructions", "memories", "user_facts", "skills", "routines", "apps"];
/** The start of an export document; one left unclosed means the reply was cut off. */
const EXPORT_START = /^\{\s*"(?:format|version|bots)"/;

/** Commas right before `}` or `]`, outside strings: what a chat window leaves behind. */
function looseJson(source: string): unknown {
  try {
    return JSON5.parse(source) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Every top-level `{…}` in a reply, by brace matching that skips JSON strings, and whether an
 * export document was left unclosed.
 */
function bracedObjects(source: string): { found: string[]; cutOff: boolean } {
  const found: string[] = [];
  let cutOff = false;
  let unbalanced = 0;
  let at = source.indexOf("{");
  while (at >= 0 && unbalanced < MAX_UNBALANCED) {
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let index = at; index < source.length && end < 0; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) end = index;
      }
    }
    if (end < 0) {
      unbalanced += 1;
      cutOff ||= EXPORT_START.test(source.slice(at, at + 40));
      at = source.indexOf("{", at + 1);
    } else {
      found.push(source.slice(at, end + 1));
      at = source.indexOf("{", end + 1);
    }
  }
  return { found, cutOff };
}

const isExportDocument = (value: unknown): value is Json =>
  isObject(value) &&
  (value.format === undefined || value.format === GROK_BOT_EXPORT_FORMAT) &&
  Array.isArray(value.bots);
const looksLikeBot = (value: unknown): value is Json =>
  isObject(value) && Boolean(text(value.name)) && BOT_FIELDS.some((key) => key in value);

/**
 * Inside a reply only export-shaped objects count, so an example routine list is not a Bot.
 * Text that is nothing but JSON may also be a bare Bot or a list of them. Curly quotes are
 * repaired only once the text as written found nothing.
 */
function documentsIn(source: string): Json[] {
  const repaired = source
    .replace(/[“”]/g, '"')
    .replace(/(?<![\p{L}\p{N}])[‘’]|[‘’](?![\p{L}\p{N}])/gu, "'");
  // Set by the last text tried: an export part that never closed would leave its setup out.
  let cutOff = false;
  for (const version of repaired === source ? [source] : [source, repaired]) {
    const whole = looseJson(version.trim());
    if (isExportDocument(whole)) return [whole];
    if (looksLikeBot(whole)) return [{ bots: [whole] }];
    if (Array.isArray(whole) && whole.length > 0 && whole.every(looksLikeBot)) {
      return [{ bots: whole }];
    }
    const scan = bracedObjects(version);
    cutOff = scan.cutOff;
    if (cutOff) continue;
    const documents = scan.found
      .map(
        (part) =>
          looseJson(part) ??
          looseJson(
            part.replace(/[“”]/g, '"').replace(/(?<![\p{L}\p{N}])[‘’]|[‘’](?![\p{L}\p{N}])/gu, "'"),
          ),
      )
      .filter(isExportDocument);
    if (documents.length > 0) return documents;
  }
  if (cutOff) throw new GrokBotExportError("cut_off");
  return [];
}

function readApp(app: unknown): GrokBotApp[] {
  const record = isObject(app) ? app : {};
  const name =
    typeof app === "string" ? app.trim() : first(record.name, record.label, record.id, record.slug);
  if (!name) return [];
  return [
    {
      name: oneLine(name),
      mcpUrl: first(record.mcp_url, record.mcpUrl, record.url),
      transport: first(record.transport, record.type).toLowerCase(),
      headerNames: isObject(record.headers) ? Object.keys(record.headers) : [],
    },
  ];
}

function readBot(bot: Json): GrokBot {
  return {
    name: oneLine(first(bot.name)),
    title: oneLine(first(bot.title)),
    description: first(bot.description),
    instructions: first(bot.instructions, bot.soul, bot.systemPrompt),
    memories: strings(bot.memories),
    userFacts: strings([...list(bot.user_facts), ...list(bot.userFacts)]),
    skills: list(bot.skills).flatMap((skill): GrokBotSkill[] => {
      if (typeof skill === "string") {
        return skill.trim() ? [{ name: oneLine(skill), description: "", instructions: "" }] : [];
      }
      if (!isObject(skill)) return [];
      return [
        {
          name: oneLine(first(skill.name, skill.title)),
          description: first(skill.description, skill.summary),
          instructions: first(skill.instructions, skill.body, skill.content, skill.text),
        },
      ];
    }),
    routines: list(bot.routines).flatMap((routine): GrokBotRoutine[] =>
      isObject(routine)
        ? [
            {
              name: oneLine(first(routine.name, routine.title)),
              instruction: first(
                routine.instruction,
                routine.prompt,
                routine.instructions,
                routine.task,
              ),
              trigger: first(routine.trigger).toLowerCase(),
              cron: first(routine.schedule_cron, routine.cron, routine.cronExpression),
              when: first(routine.schedule_text, routine.schedule, routine.when),
              timeZone: first(routine.timezone, routine.timeZone, routine.tz),
              skills: strings(routine.skills),
              details: first(routine.trigger_details, routine.details),
            },
          ]
        : [],
    ),
    apps: [...list(bot.apps), ...list(bot.plugins), ...list(bot.integrations)].flatMap(readApp),
  };
}

/**
 * One Bot per name: lists join, dropping exact repeats, instructions join their distinct
 * parts, and other fields keep the last non-empty value, so a split or repeated export brings
 * each thing once.
 */
function mergeBots(bots: readonly GrokBot[]): GrokBot[] {
  const union = <T>(mine: T[], theirs: T[]) => [
    ...new Map([...mine, ...theirs].map((item) => [JSON.stringify(item), item])).values(),
  ];
  const merged = new Map<string, GrokBot>();
  for (const bot of bots) {
    const key = bot.name.toLowerCase();
    const into = merged.get(key);
    merged.set(
      key,
      into
        ? {
            name: into.name,
            title: bot.title || into.title,
            description: bot.description || into.description,
            instructions: into.instructions.includes(bot.instructions)
              ? into.instructions
              : bot.instructions.includes(into.instructions)
                ? bot.instructions
                : `${into.instructions}\n\n${bot.instructions}`,
            memories: union(into.memories, bot.memories),
            userFacts: union(into.userFacts, bot.userFacts),
            skills: union(into.skills, bot.skills),
            routines: union(into.routines, bot.routines),
            apps: union(into.apps, bot.apps),
          }
        : bot,
    );
  }
  const result = [...merged.values()];
  for (const bot of result) {
    const names = new Set<string>();
    for (const routine of bot.routines) {
      const name = routine.name.toLowerCase();
      if (name && names.has(name)) throw new GrokBotExportError("not_export");
      if (name) names.add(name);
    }
  }
  if (
    result.some((bot) =>
      [bot.skills, bot.apps, bot.routines, bot.memories, bot.userFacts].some(
        (items) => items.length > 100,
      ),
    )
  )
    throw new GrokBotExportError("too_large");
  return result;
}

/** Refuses newer formats, then joins the Bots by name. */
function botsIn(documents: readonly Json[]): GrokBot[] {
  if (documents.some((document) => Number(document.version) > 1)) {
    throw new GrokBotExportError("newer_version");
  }
  const raw = documents.flatMap((document) =>
    Array.isArray(document.bots) ? document.bots.filter(isObject) : [document],
  );
  if (
    raw.length > 100 ||
    raw.some((bot) =>
      [
        bot.skills,
        bot.apps,
        bot.plugins,
        bot.integrations,
        bot.routines,
        bot.memories,
        bot.user_facts,
        bot.userFacts,
      ].some((items) => Array.isArray(items) && items.length > 100),
    )
  )
    throw new GrokBotExportError("too_large");
  const bots = mergeBots(raw.map(readBot).filter((bot) => bot.name));
  if (bots.length === 0) throw new GrokBotExportError("not_export");
  return bots;
}

/**
 * The Bots in a reply or file: a bare document, a fenced one, or several with chat text
 * around them. Key-shaped text the reader keeps is flagged or screened later, never silently
 * imported.
 */
export function parseGrokBotExport(source: string): GrokBot[] {
  if (source.length > GROK_BOT_REPLY_MAX_LENGTH) throw new GrokBotExportError("too_large");
  const documents = documentsIn(source.replace(/^\uFEFF/, ""));
  if (documents.length === 0) {
    const cutOff = source.split("{").length > source.split("}").length;
    throw new GrokBotExportError(cutOff ? "cut_off" : "not_export");
  }
  return botsIn(documents);
}

/** The one document `grokBotExportJson` writes, read strictly: no repairs, no searching. */
export function readGrokBotExportJson(source: string): GrokBot[] {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    throw new GrokBotExportError("not_export");
  }
  if (!isExportDocument(document)) throw new GrokBotExportError("not_export");
  return botsIn([document]);
}

/** One Bot as an export document; both readers read it back unchanged. */
export function grokBotExportJson(bot: GrokBot): string {
  return JSON.stringify({
    format: GROK_BOT_EXPORT_FORMAT,
    version: 1,
    bots: [
      {
        name: bot.name,
        title: bot.title,
        description: bot.description,
        instructions: bot.instructions,
        memories: bot.memories,
        user_facts: bot.userFacts,
        skills: bot.skills,
        routines: bot.routines.map((routine) => ({
          name: routine.name,
          instruction: routine.instruction,
          trigger: routine.trigger,
          schedule_cron: routine.cron,
          schedule_text: routine.when,
          timezone: routine.timeZone,
          skills: routine.skills,
          trigger_details: routine.details,
        })),
        apps: bot.apps.map((app) => ({
          name: app.name,
          mcp_url: app.mcpUrl,
          transport: app.transport,
          headers: Object.fromEntries(app.headerNames.map((name) => [name, ""])),
        })),
      },
    ],
  });
}

const CLOCK_TRIGGERS = new Set(["", "schedule", "scheduled", "time", "cron", "interval"]);

/** The routine's cron when it runs on a clock and the cron is valid; null otherwise. */
export function grokRoutineCron(routine: GrokBotRoutine): string | null {
  if (!CLOCK_TRIGGERS.has(routine.trigger)) return null;
  for (const candidate of [routine.cron, routine.when]) {
    if (!candidate) continue;
    try {
      if (nextCronDateAcrossStrict([candidate], new Date(), "UTC") !== null) return candidate;
    } catch {
      // Not a cron: the words, or nothing.
    }
  }
  return null;
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Each skill as it is saved, or the reason it is not, in export order. */
function grokSkills(bot: GrokBot) {
  const used = new Set<string>();
  return bot.skills.map((skill, index) => {
    const path = `skills/${skill.name || index + 1}`;
    const body = skill.instructions.replace(FRONTMATTER, "").trim();
    const parsed = FRONTMATTER.test(skill.instructions) ? parseSkillMd(skill.instructions) : null;
    const front = parsed && !("error" in parsed) ? parsed : null;
    if (!body && !front) return { source: skill, path, item: null };
    const fromFront = front?.description ?? "";
    const firstLine = body.split("\n").find((line) => line.trim()) ?? "";
    const description = oneLine(
      skill.description || fromFront || firstLine.replace(/^#+\s*/, ""),
    ).slice(0, 2000);
    const name = freeName(slug(skill.name) || `skill-${index + 1}`, used, "");
    let item: AgentImportSkill | null = null;
    try {
      // A complete SKILL.md keeps every byte but its name, so nested metadata (requirements,
      // platforms) still marks what it needs; the frontmatter parser would flatten it.
      const markdown = front
        ? renameSkillMd(skill.instructions, name)
        : `${buildSkillMd({ name, description, body })}\n`;
      item = skillItem(`skills:${name}`, markdown);
    } catch {
      item = null;
    }
    return { source: skill, path, item };
  });
}

/** Lowercase name in the export → the name the skill is saved under. */
export function grokSkillNames(bot: GrokBot): Map<string, string> {
  return new Map(
    grokSkills(bot).flatMap(({ source, item }) =>
      item
        ? [
            [source.name.toLowerCase(), item.name] as const,
            [item.name.toLowerCase(), item.name] as const,
          ]
        : [],
    ),
  );
}

/** One bullet per entry; an entry's own lines stay, indented under it. */
function bullets(lines: readonly string[]): string {
  return `${lines.map((line) => `- ${line.replace(/\r?\n/g, "\n  ")}`).join("\n")}\n`;
}

/** Each routine with every setting the export gave, so it can be set up again by hand. */
function routinesToSetUp(routines: readonly GrokBotRoutine[]): string {
  const blocks = routines.map((routine) => {
    const fields = [
      ["Trigger", routine.trigger || "unknown"],
      ["Details", routine.details],
      ["Schedule", routine.when],
      ["Cron", routine.cron],
      ["Time zone", routine.timeZone],
      ["Skills", routine.skills.join(", ")],
    ].flatMap(([label, value]) => (value ? [`- ${label}: ${value}`] : []));
    return `## ${routine.name || "Routine"}\n\n${fields.join("\n")}\n\n${routine.instruction}\n`;
  });
  return `# Grok Bot routines to set up again\n\nThese run on an event, or on a schedule that could not be read.\n\n${blocks.join("\n")}`;
}

/** Imported text is data: nothing here follows it. Routines and apps are added by the server. */
export function parseGrokBot(bot: GrokBot): AgentImportParse {
  // Each field on its own: a fact in both stays in both documents.
  const fresh = (lines: readonly string[]) => {
    const seen = new Set<string>();
    return lines.filter((line) => {
      const key = line.replace(/\s+/g, " ").trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const memories = fresh(bot.memories);
  const userFacts = fresh(bot.userFacts);
  const toSetUp = bot.routines.filter(
    (routine) => routine.instruction && grokRoutineCron(routine) === null,
  );
  const memory: AgentImportMemory[] = [
    ...(memories.length
      ? [memoryItem("MEMORY.md", "MEMORY.md", "MEMORY.md", bullets(memories))]
      : []),
    ...(userFacts.length ? [memoryItem("USER.md", "USER.md", "USER.md", bullets(userFacts))] : []),
    ...(toSetUp.length
      ? [
          memoryItem(
            GROK_BOT_ROUTINES_PATH,
            GROK_BOT_ROUTINES_PATH,
            GROK_BOT_ROUTINES_PATH,
            routinesToSetUp(toSetUp),
          ),
        ]
      : []),
  ];
  const skills = grokSkills(bot);
  const instructions = bot.instructions.trim();
  return {
    suggestedName: bot.name.slice(0, BOT_NAME_MAX_LENGTH),
    suggestedDescription: (bot.description || bot.title).slice(0, BOT_DESCRIPTION_MAX_LENGTH),
    instructions: instructions
      ? [
          {
            id: "instructions:instructions",
            title: "Instructions",
            content: `${instructions}\n`,
            role: "working",
            stock: false,
            mentions: [],
          },
        ]
      : [],
    memory,
    skills: skills.flatMap(({ item }) => (item ? [item] : [])),
    skipped: skills.flatMap(({ item, path }) =>
      item ? [] : [{ path, reason: "invalid_skill" as const }],
    ),
  };
}
