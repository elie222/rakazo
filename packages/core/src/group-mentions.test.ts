import { describe, expect, it } from "vitest";
import {
  filterSelectedMentionsByText,
  hasMentionToken,
  inferHandoffTargetBotId,
  inferHandoffTargetName,
  mentionInsertToken,
  resolveGroupTargetBotIds,
  stripMentionToken,
} from "./group-mentions.js";

const members = [
  { id: "a", name: "BotA" },
  { id: "b", name: "BotB" },
  { id: "c", name: "Writer" },
];

describe("hasMentionToken", () => {
  it("requires a boundary after the complete member name", () => {
    expect(hasMentionToken("Ask @Ann to review", "Ann")).toBe(true);
    expect(hasMentionToken("Ask @Ann, then continue", "Ann")).toBe(true);
    expect(hasMentionToken("Ask @Anna to review", "Ann")).toBe(false);
    expect(hasMentionToken("name@Ann", "Ann")).toBe(false);
    expect(hasMentionToken("contact@everyone", "everyone")).toBe(false);
  });

  it("supports multi-word and Unicode member names", () => {
    expect(hasMentionToken("Ask @Research Writer and @Éditeur", "Research Writer")).toBe(true);
    expect(hasMentionToken("Ask @Research Writer and @Éditeur", "Éditeur")).toBe(true);
  });
});

describe("mentionInsertToken", () => {
  it("disambiguates duplicate visible names", () => {
    expect(mentionInsertToken("Daily", "routine-abc123", [])).toBe("Daily");
    expect(
      mentionInsertToken("Daily", "routine-def456", [{ name: "Daily", id: "routine-abc123" }]),
    ).toBe("Daily-f456");
  });
});

describe("filterSelectedMentionsByText", () => {
  it("binds picker-selected mentions by full name, including spaces", () => {
    const group = { kind: "group", id: "g1", name: "Draft team" };
    const routine = { kind: "routine", id: "r1", name: "Daily digest" };
    expect(filterSelectedMentionsByText("@Draft team sync up", [group])).toEqual([group]);
    expect(filterSelectedMentionsByText("@Daily digest check inbox", [routine])).toEqual([routine]);
    expect(filterSelectedMentionsByText("sync up", [group])).toEqual([]);
  });

  it("keeps disambiguated duplicate names when each token is visible", () => {
    const first = { kind: "routine", id: "r1", name: "Daily" };
    const second = { kind: "routine", id: "r2", name: "Daily-f456" };
    expect(filterSelectedMentionsByText("@Daily check inbox", [first, second])).toEqual([first]);
    expect(filterSelectedMentionsByText("@Daily @Daily-f456 check inbox", [first, second])).toEqual(
      [first, second],
    );
    expect(filterSelectedMentionsByText("check inbox", [first, second])).toEqual([]);
  });
});

describe("stripMentionToken", () => {
  it("uses the same boundaries as hasMentionToken", () => {
    expect(stripMentionToken("(check @Gmail) now", "Gmail")).toBe("(check ) now");
    expect(hasMentionToken("(check @Gmail) now", "Gmail")).toBe(true);
    expect(hasMentionToken("name@Gmail", "Gmail")).toBe(false);
  });
});

describe("resolveGroupTargetBotIds", () => {
  it("returns mentioned bots from text", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "@BotA gather sources. @BotB summarize.",
        members,
      }),
    ).toEqual(["a", "b"]);
  });

  it("returns all members for @everyone", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "@everyone please review",
        members,
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("merges explicit mentions", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello",
        members,
        explicitMentions: ["b"],
      }),
    ).toEqual(["b"]);
  });

  it("matches multi-word and Unicode names without prefix collisions", () => {
    const namedMembers = [
      { id: "research", name: "Research Writer" },
      { id: "edit", name: "Éditeur" },
      { id: "ann", name: "Ann" },
      { id: "anna", name: "Anna" },
    ];
    expect(
      resolveGroupTargetBotIds({
        text: "@Research Writer compare this with @Éditeur and @Anna.",
        members: namedMembers,
      }),
    ).toEqual(["research", "edit", "anna"]);
  });

  it("picks the first member when unmentioned", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello team",
        members,
      }),
    ).toEqual(["a"]);
  });
});

describe("inferHandoffTargetName", () => {
  it("picks Writer when BotA is also mentioned", () => {
    expect(inferHandoffTargetName("@BotA hand this to Writer for the draft")).toBe("Writer");
  });
});

describe("inferHandoffTargetBotId", () => {
  it("recognizes hand this to Writer", () => {
    expect(inferHandoffTargetBotId("hand this to Writer for the draft", members)).toBe("c");
  });

  it("recognizes @Writer take the draft", () => {
    expect(inferHandoffTargetBotId("@Writer take the draft", members)).toBe("c");
  });

  it("resolves Writer from mixed mention prompt", () => {
    expect(inferHandoffTargetBotId("@BotA hand this to Writer for the draft", members)).toBe("c");
  });

  it("resolves multi-word handoff targets", () => {
    expect(
      inferHandoffTargetBotId("hand this to Research Writer for the draft", [
        ...members,
        { id: "research", name: "Research Writer" },
      ]),
    ).toBe("research");
  });
});
