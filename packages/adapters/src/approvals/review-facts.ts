import type { AutoReviewDetail, AutoReviewFacts, AutoReviewValueSource } from "@rakazo/adapter-kit";
import { sitesInText } from "@rakazo/core/egress";
import { listPiCatalog } from "../runtime/pi/models/pi-models.js";
import { truncateReviewText } from "./auto-review.prompt.js";

/** How many of the owner's earlier messages the reviewer sees, and how much of each. */
export const REVIEW_OWNER_MESSAGES = 3;
const MAX_OWNER_MESSAGE_CHARS = 300;
/** Enough for a batch's recipients, without letting one call bury the reviewer's input. */
const MAX_DETAILS = 12;
/** How deep and how many values of a call's arguments are read for facts. */
const MAX_ARG_DEPTH = 6;
const MAX_ARG_VALUES = 400;

/** The owner's last few earlier messages, oldest first, each capped. */
export function reviewOwnerMessages(messages: readonly string[]): string[] {
  return messages
    .map((message) => message.trim())
    .filter(Boolean)
    .slice(-REVIEW_OWNER_MESSAGES)
    .map((message) => truncateReviewText(message, MAX_OWNER_MESSAGE_CHARS));
}

type ArgValue = { key: string; path: string; value: unknown; parent: Record<string, unknown> };

function argValues(args: Record<string, unknown>): ArgValue[] {
  const values: ArgValue[] = [];
  const walk = (
    node: unknown,
    path: string,
    key: string,
    parent: Record<string, unknown>,
    depth: number,
  ) => {
    if (values.length >= MAX_ARG_VALUES || depth > MAX_ARG_DEPTH) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, path, key, parent, depth + 1);
    } else if (node && typeof node === "object") {
      const object = node as Record<string, unknown>;
      for (const [childKey, child] of Object.entries(object))
        walk(child, path ? `${path}.${childKey}` : childKey, childKey, object, depth + 1);
    } else values.push({ key, path, value: node, parent });
  };
  walk(args, "", "", args, 0);
  return values;
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const PHONE = /(?<![\p{L}\p{N}])\+?\d[\d ().-]{6,}\d(?![\p{L}\p{N}])/gu;
const HANDLE = /^[#@][\p{L}\p{N}._-]{1,80}$/u;
/** Keys whose values say who receives something. */
const RECIPIENT_KEY =
  /(^|_|-)(to|cc|bcc|recipients?|emails?|phone|number|channel|attendees?|invitees?|members?|users?|assignees?|reviewers?|collaborators?|share_with)$|recipient|attendee|invitee|collaborator/i;
/** Keys whose values are money. */
const MONEY_KEY =
  /(^|_|-)(amount|price|total|cost|budget|fee|charge|tip|payment|unit_amount|max_amount|limit)s?($|_|-)|amount|price/i;
const MINOR_UNITS_KEY = /cents|minor/i;
const MICROS_KEY = /micros/i;
const MINOR_UNITS_DESCRIPTION =
  /smallest currency unit|minor (currency )?unit|in cents\b|\bcents\b/i;

/** A model name's words and versions: "claude-sonnet-5-5" and "Claude Sonnet 5.5" match. */
const modelWords = (text: string): string[] =>
  normalize(text)
    .replace(/(\d)[-_](\d)(?!\d)/g, "$1.$2")
    .match(/\p{L}+|\d+(?:\.\d+)*/gu) ?? [];
const normalize = (text: string) => text.toLowerCase().normalize("NFKC");
const digits = (text: string) => text.replace(/\D/g, "");

/** Numbers written in text, so "$1,250", "1250.00" and "€40" are compared as amounts. */
function numbersIn(text: string): number[] {
  return [...text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k)?(?![\d])/gi)].flatMap(
    ([, raw, thousands]) => {
      const value = Number(raw!.replace(/,/g, ""));
      return Number.isFinite(value) ? [thousands ? value * 1000 : value] : [];
    },
  );
}

function propertyDescription(schema: unknown, path: string): string {
  let node = schema as { properties?: Record<string, unknown>; items?: unknown } | undefined;
  for (const part of path.split(".")) {
    while (node && !node.properties && node.items) node = node.items as typeof node;
    node = node?.properties?.[part] as typeof node;
  }
  const description = (node as { description?: unknown } | undefined)?.description;
  return typeof description === "string" ? description : "";
}

/**
 * Facts about one call, worked out from the run rather than asked of the reviewer: where each
 * recipient, site and amount came from, the model it sets, and whether outside text entered the
 * run. `ownerWords` holds only the owner's own words; `readContent` what the run's tools returned
 * and what others sent it.
 */
export function reviewFacts(input: {
  args: Record<string, unknown>;
  ownerWords: string;
  readContent: string;
  outsideContent: boolean;
  /** The tool's input schema, whose descriptions say when an amount is in minor units. */
  inputSchema?: unknown;
  knownModel: (id: string) => boolean;
}): AutoReviewFacts | undefined {
  const owner = normalize(input.ownerWords);
  const read = normalize(input.readContent);
  const ownerDigits = [...input.ownerWords.matchAll(PHONE)].map(([m]) => digits(m));
  const readDigits = [...input.readContent.matchAll(PHONE)].map(([m]) => digits(m));
  const ownerSites = sitesInText(input.ownerWords);
  const readSites = sitesInText(input.readContent);
  const ownerNumbers = numbersIn(input.ownerWords);
  const readNumbers = numbersIn(input.readContent);
  const ownerNameWords = new Set(owner.match(/\p{L}{3,}/gu) ?? []);
  const details: AutoReviewDetail[] = [];
  const seen = new Set<string>();
  const add = (kind: AutoReviewDetail["kind"], value: string, source: AutoReviewValueSource) => {
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    details.push({ kind, value, source });
  };
  const textSource = (value: string): AutoReviewValueSource => {
    const needle = normalize(value);
    return owner.includes(needle) ? "owner" : read.includes(needle) ? "read" : "neither";
  };
  let model: AutoReviewFacts["model"];
  for (const { key, path, value, parent } of argValues(input.args)) {
    if (typeof value === "string") {
      for (const [email] of value.matchAll(EMAIL)) {
        let source = textSource(email);
        // "Email Dana" names the person; her address came from a lookup.
        if (source !== "owner") {
          const local = normalize(email.split("@")[0]!).match(/\p{L}{3,}/gu) ?? [];
          if (local.some((word) => ownerNameWords.has(word)) && source === "neither")
            source = "owner_named";
        }
        add("recipient", email.toLowerCase(), source);
      }
      if (RECIPIENT_KEY.test(key)) {
        for (const [phone] of value.matchAll(PHONE)) {
          const d = digits(phone);
          add(
            "recipient",
            phone.trim(),
            ownerDigits.some((o) => o.endsWith(d) || d.endsWith(o))
              ? "owner"
              : readDigits.some((o) => o.endsWith(d) || d.endsWith(o))
                ? "read"
                : "neither",
          );
        }
        if (HANDLE.test(value.trim())) add("recipient", value.trim(), textSource(value.trim()));
      }
      for (const site of sitesInText(value))
        add(
          "site",
          site,
          ownerSites.has(site) ? "owner" : readSites.has(site) ? "read" : "neither",
        );
      if (/^(model|model_?id)$/i.test(key) && value.trim()) {
        const id = value.trim();
        const nameWords = modelWords(id.split("/").at(-1)!);
        const ownerModelWords = modelWords(input.ownerWords);
        model = {
          id,
          known: input.knownModel(id),
          // People name a model by its family and version ("GPT-6", "Llama 4"), not its variant.
          namedByOwner:
            owner.includes(normalize(id)) ||
            (nameWords.length > 0 &&
              nameWords.slice(0, 2).every((word) => ownerModelWords.includes(word))),
        };
      }
    }
    if (MONEY_KEY.test(key) && !/currency|count|quantity/i.test(key)) {
      const raw =
        typeof value === "number"
          ? value
          : typeof value === "string"
            ? numbersIn(value)[0]
            : undefined;
      if (raw === undefined) continue;
      const unit =
        typeof value !== "number"
          ? 1
          : MICROS_KEY.test(key)
            ? 1_000_000
            : MINOR_UNITS_KEY.test(key) ||
                MINOR_UNITS_DESCRIPTION.test(propertyDescription(input.inputSchema, path))
              ? 100
              : 1;
      const minor = unit > 1;
      const amount = raw / unit;
      const currency =
        typeof parent.currency === "string" ? ` ${parent.currency.toLowerCase()}` : "";
      const matches = (numbers: number[]) => numbers.some((n) => Math.abs(n - amount) < 0.005);
      add(
        "amount",
        `${minor ? amount.toFixed(2) : String(amount)}${currency}`,
        matches(ownerNumbers) ? "owner" : matches(readNumbers) ? "read" : "neither",
      );
    }
  }
  if (!details.length && !model && !input.outsideContent) return undefined;
  return {
    outsideContent: input.outsideContent,
    details: details.slice(0, MAX_DETAILS),
    ...(model ? { model } : {}),
  };
}

let catalogIds: Set<string> | undefined;
/** Whether the model catalog lists this id, bare or under its provider. */
export function catalogKnowsModel(id: string): boolean {
  catalogIds ??= new Set(
    listPiCatalog().flatMap((entry) => [
      entry.id.toLowerCase(),
      `${entry.provider}/${entry.id}`.toLowerCase(),
    ]),
  );
  return catalogIds.has(id.trim().toLowerCase());
}
