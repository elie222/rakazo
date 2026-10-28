import { describe, expect, it } from "vitest";
import type { ComposerMentionBinding } from "./composer-mention-bindings.js";
import {
  bindComposerMention,
  composerMentionsForPrompt,
  composerSelectedMentions,
  removeBoundComposerMention,
  updateComposerMentionBindings,
  validateComposerMentionBindings,
} from "./composer-mention-bindings.js";
import type { ComposerMention, ComposerMentionRange } from "./composer-mentions.js";
import { composerMentionQuery, resolveComposerSendPlan } from "./composer-mentions.js";
import { serializeComposerPrompt } from "./composer-slash.js";

const bot: ComposerMention = { kind: "bot", id: "bot-bob", name: "Bob" };
const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
const text = "@Bob and @Bob ";
const bindings: ComposerMentionBinding[] = [
  { start: 0, end: 4, mention: bot },
  { start: 9, end: 13, mention: group },
];

describe("completed mention occurrence bindings", () => {
  it.each([0, 1])("retires only edited occurrence %s despite identical names", (index) => {
    const removed = bindings[index]!;
    const next = text.slice(0, removed.start) + text.slice(removed.end);
    const retained = updateComposerMentionBindings(text, next, bindings, {
      before: [removed],
      after: { start: removed.start, end: removed.start },
    });
    expect(composerSelectedMentions(retained)).toEqual([bindings[1 - index]!.mention]);
  });

  it.each([false, true])(
    "maps identical adjacent deletion using native edit selection (selection-first %s)",
    (selectionFirst) => {
      const before = [{ start: 0, end: 5 }];
      if (selectionFirst) before.unshift({ start: 0, end: 0 });
      const result = updateComposerMentionBindings(
        "@Bob @Bob ",
        "@Bob ",
        [
          { start: 0, end: 4, mention: bot },
          { start: 5, end: 9, mention: group },
        ],
        { before, after: { start: 0, end: 0 } },
      );
      expect(result).toEqual([{ start: 0, end: 4, mention: group }]);
    },
  );

  it("does not retain an intersected binding when an edited name still appears elsewhere", () => {
    const next = text.replace("and @Bob", "and @Bobby");
    expect(composerSelectedMentions(updateComposerMentionBindings(text, next, bindings))).toEqual([
      bot,
    ]);
  });

  it("shifts untouched occurrences through a prefix edit", () => {
    const next = `please ${text}`;
    expect(updateComposerMentionBindings(text, next, bindings)).toEqual(
      bindings.map((binding) => ({ ...binding, start: binding.start + 7, end: binding.end + 7 })),
    );
  });

  it("retires a binding when a letter is inserted at its token boundary", () => {
    expect(
      updateComposerMentionBindings("@Bob ", "@Bobby ", [bindings[0]!], {
        before: [{ start: 4, end: 4 }],
        after: { start: 6, end: 6 },
      }),
    ).toEqual([]);
  });

  it("completion replaces the bound occurrence identity even when the text is unchanged", () => {
    const query = composerMentionQuery(text, 2, 2, [bot, group], bindings)!;
    const result = bindComposerMention(text, query, group, bindings);
    expect(result.text).toBe(text);
    expect(result.bindings.map((binding) => binding.mention)).toEqual([group, group]);
    expect(composerSelectedMentions(result.bindings)).toEqual([group]);
  });

  it.each([bot, group])("chip removal targets kind/id for $kind", (target) => {
    const removed = removeBoundComposerMention(text, bindings, target, {
      start: text.length,
      end: text.length,
    });
    expect(removed.text).toBe(target === bot ? " and @Bob " : "@Bob and  ");
    expect(composerSelectedMentions(removed.bindings)).toEqual([target === bot ? group : bot]);
  });

  it("deduplicates routing but retains repeated occurrences for removal", () => {
    const twice = bindings.map((binding) => ({ ...binding, mention: bot }));
    expect(composerSelectedMentions(twice)).toEqual([bot]);
    expect(removeBoundComposerMention(text, twice, bot, { start: 14, end: 14 })).toMatchObject({
      text: " and  ",
      bindings: [],
      selection: { start: 6, end: 6 },
    });
  });

  it.each([
    [
      { start: 0, end: 0 },
      { start: 0, end: 0 },
    ],
    [
      { start: 3, end: 3 },
      { start: 0, end: 0 },
    ],
    [
      { start: 11, end: 11 },
      { start: 4, end: 4 },
    ],
    [
      { start: 4, end: 11 },
      { start: 0, end: 4 },
    ],
    [
      { start: 11, end: 20 },
      { start: 4, end: 13 },
    ],
  ] as [ComposerMentionRange, ComposerMentionRange][])(
    "transforms both endpoints %j",
    (selection, expected) => {
      const helper = { kind: "bot", id: "helper", name: "Helper" } as const;
      expect(
        removeBoundComposerMention(
          "@Helper one two three four",
          [{ start: 0, end: 7, mention: helper }],
          helper,
          selection,
        ).selection,
      ).toEqual(expected);
    },
  );

  it("preserves the bot's same-name text when stripping a separate group occurrence", () => {
    const draft = "  @Bob and @Bob ";
    const occurrences = bindings.map((binding) => ({
      ...binding,
      start: binding.start + 2,
      end: binding.end + 2,
    }));
    for (const skill of [null, { name: "Write" }]) {
      const prompt = serializeComposerPrompt(draft, skill);
      const mentions = composerMentionsForPrompt(draft, skill, occurrences);
      expect(
        resolveComposerSendPlan({ text: prompt, mentions, hasAttachments: false }),
      ).toMatchObject({
        trimmed: skill ? "/Write\n@Bob and" : "@Bob and",
        rerouteGroupId: group.id,
        mentionPayload: [{ kind: "bot", id: bot.id }],
      });
    }
  });

  it("prioritizes an explicitly bound short name over an unselected longer catalog name", () => {
    const value = "@Bob Smith ";
    expect(composerMentionQuery(value, 2, 2, [bot, { name: "Bob Smith" }], [bindings[0]!])).toEqual(
      { start: 0, end: 4, query: "B" },
    );
  });

  it("validates persisted metadata without inferring ambiguous identities", () => {
    expect(validateComposerMentionBindings(text, bindings)).toEqual(bindings);
    expect(
      validateComposerMentionBindings(text, [
        ...bindings,
        { start: 0, end: 4, mention: group },
        { start: 99, end: 103, mention: bot },
      ]),
    ).toEqual(bindings);
    expect(validateComposerMentionBindings("changed", bindings)).toEqual([]);
    expect(validateComposerMentionBindings(text, { name: "Bob" })).toEqual([]);
  });
});
