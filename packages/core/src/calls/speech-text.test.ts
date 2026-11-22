import { expectLinearTime } from "@rakazo/contracts/test-timing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  narrateTool,
  sentenceKey,
  speakable,
  speechFromBlocks,
  splitSentences,
  spokenDecision,
  toUtterances,
} from "./speech-text.js";

describe("speakable", () => {
  it("names a code block instead of reading it", () => {
    const out = speakable(
      "Here's the fix:\n\n```ts\nconst x: number = 1;\nif (x) throw new Error('no');\n```\n\nThat's it.",
    );
    expect(out).toContain("TypeScript code block");
    expect(out).not.toContain("const x");
    expect(out).not.toContain("throw");
    expect(out).toContain("That's it.");
  });

  it("closes an unterminated fence rather than swallowing the rest", () => {
    const out = speakable("Working on it:\n\n```sh\nnpm test");
    expect(out).toContain("Working on it");
    expect(out).toContain("code block");
    expect(out).not.toContain("npm test");
  });

  it("keeps a link's words and drops its URL", () => {
    expect(speakable("See [the README](https://example.com/a/b?c=d) for more")).toBe(
      "See the README for more",
    );
  });

  it("turns a bare URL into a noun", () => {
    expect(speakable("Deployed to https://status.example.com/health now")).toBe(
      "Deployed to a link now",
    );
  });

  it("says the file, not the path to it", () => {
    expect(speakable("I changed server/drivers/acp/core.ts today")).toBe("I changed core.ts today");
    expect(speakable("open @scope/pkg/src/index.ts, ok")).toBe("open index.ts, ok");
    const run = "a/".repeat(100_000);
    expectLinearTime(() => expect(speakable(run)).toBe(run));
    expect(speakable(`see ${"a/".repeat(300)}file.ts now`)).toBe("see file.ts now");
  });

  it("keeps short inline code but not long snippets", () => {
    expect(speakable("Run `pnpm test` first")).toBe("Run pnpm test first");
    const long = speakable(`Use \`${"x".repeat(60)}\` here`);
    expect(long).toBe("Use that snippet here");
  });

  it("strips list scaffolding but keeps the pause between items", () => {
    const out = speakable("- first thing\n- second thing\n- third thing");
    expect(out).toBe("first thing. second thing. third thing");
  });

  it("reads a table as rows, not pipes", () => {
    const out = speakable("| Name | State |\n| --- | --- |\n| Scout | idle |");
    expect(out).not.toContain("|");
    expect(out).not.toContain("---");
    expect(out).toContain("Scout, idle");
  });

  it("drops emphasis markers, emoji and checkboxes", () => {
    expect(speakable("**Done** ✅ — [x] shipped the _thing_")).toBe("Done — shipped the thing");
  });

  it("keeps double-asterisk operators while still dropping bold", () => {
    expect(speakable("Compute 2 ** 3 ** 4 now")).toBe("Compute 2 ** 3 ** 4 now");
    expect(speakable("**bold** words")).toBe("bold words");
  });

  it("keeps underscores inside identifiers and asterisks in arithmetic", () => {
    expect(speakable("Open user_profile_page.tsx and set max_retry_count to 3")).toBe(
      "Open user_profile_page.tsx and set max_retry_count to 3",
    );
    expect(speakable("compute 2*3*4 now")).toBe("compute 2*3*4 now");
    expect(speakable("a_b and c_d")).toBe("a_b and c_d");
  });

  it("strips emphasis in linear time on markers that never close", () => {
    for (const unit of ["(_a", ".*a", "(*a_"]) {
      const text = unit.repeat(Math.floor(200_000 / unit.length));
      expectLinearTime(() => expect(speakable(text)).toBe(text));
    }
  });

  it("still drops emphasis markers around a word or phrase", () => {
    expect(speakable("this is _really_ good")).toBe("this is really good");
    expect(speakable("this is *really* good")).toBe("this is really good");
    expect(speakable("this is *very good indeed* here")).toBe("this is very good indeed here");
    expect(speakable("(_note_) and *(this)*")).toBe("(note) and (this)");
    expect(speakable("*one* and _two_ but a_b_c and 2*3")).toBe("one and two but a_b_c and 2*3");
    expect(speakable("*not closed\non this line*")).toBe("*not closed. on this line*");
  });

  it("drops a horizontal rule however it is spaced", () => {
    for (const rule of ["---", "***", "___", "* * *", "- - -", "_ _ _", "  ***  ", "-----"]) {
      expect(speakable(`Intro\n\n${rule}\n\nBody`)).toBe("Intro. Body");
    }
  });

  it("keeps a bullet list that has a rule-like first item", () => {
    expect(speakable("- one\n- two")).toBe("one. two");
    expect(speakable("* one\n* two")).toBe("one. two");
  });

  it("gives a heading a full stop so the voice breathes", () => {
    expect(speakable("## Results\nAll green")).toBe("Results. All green");
  });

  it("collapses the punctuation its own substitutions create", () => {
    expect(speakable("Done.\n\n\n- one\n\n- two")).toBe("Done. one. two");
  });

  it("is empty for empty input", () => {
    expect(speakable("")).toBe("");
    expect(speakable("   \n\n  ")).toBe("");
  });

  it("joins message blocks into something a voice can read", () => {
    expect(
      speechFromBlocks([
        { kind: "text", text: "Done." },
        { kind: "ask", text: "Ship it?", status: "pending" },
      ]),
    ).toContain("Ship it?");
  });

  it("leaves tool activity out of what a voice reads, keeping the bot's own narration", () => {
    expect(
      speechFromBlocks([
        { kind: "steps", steps: [{ label: "Shell", count: 2 }] },
        { kind: "progress", text: "Using shell", activity: true },
        { kind: "progress", text: "Let me check the build." },
        { kind: "text", text: "It passes." },
      ]),
    ).toBe("Let me check the build.\nIt passes.");
    expect(
      speechFromBlocks([{ kind: "progress", text: "Searching the web: weather", activity: true }]),
    ).toBe("");
  });
});

describe("toUtterances", () => {
  it("splits on sentences", () => {
    const out = toUtterances("The tests pass now. I changed two files. Want me to push it?");
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("The tests pass now.");
    expect(out[2]).toBe("Want me to push it?");
  });

  it("does not split inside a decimal or an abbreviation", () => {
    const out = toUtterances(
      "It dropped to 11.7 seconds per step, i.e. about half of what it was before.",
    );
    expect(out).toHaveLength(1);
  });

  it("glues a fragment onto its neighbour", () => {
    const out = toUtterances("Yes. The whole suite is green and nothing else changed.");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Yes.");
  });

  it("breaks a runaway sentence at a clause, never mid-word", () => {
    const long = `I looked at ${Array.from({ length: 40 }, (_, i) => `item ${i}`).join(", ")} and finished.`;
    const out = toUtterances(long, { maxChars: 120 });
    expect(out.length).toBeGreaterThan(1);
    for (const piece of out) expect(piece.length).toBeLessThanOrEqual(120);
    expect(out.join(" ")).toContain("item 39");
  });

  it.each([
    ["Chinese", "中".repeat(2400)],
    ["Japanese", "あ".repeat(2400)],
    ["an unbroken word", "a".repeat(2400)],
  ])("bounds %s without dropping or inserting characters", (_name, text) => {
    const out = toUtterances(text);
    expect(out.length).toBeGreaterThan(1);
    for (const piece of out) {
      expect(piece.length).toBeGreaterThan(0);
      expect(piece.length).toBeLessThanOrEqual(320);
    }
    expect(out.join("")).toBe(text);
  });

  it.each([
    [320, [320]],
    [321, [320, 1]],
    [641, [320, 320, 1]],
  ])("handles a %i-character boundary", (length, chunkLengths) => {
    const text = "中".repeat(length);
    const out = toUtterances(text);
    expect(out.map((piece) => piece.length)).toEqual(chunkLengths);
    expect(out.join("")).toBe(text);
  });

  it.each([
    ["supplementary CJK", "𠮷"],
    ["combining marks", "e\u0301"],
    ["a joined Indic cluster", "क्\u200dष"],
    ["a supplementary variation selector", "葛\u{e0100}"],
  ])("keeps %s together at the limit", (_name, cluster) => {
    const prefix = "中".repeat(319);
    const text = prefix + cluster.repeat(600);
    const out = toUtterances(text);
    expect(out[0]).toBe(prefix);
    for (const piece of out.slice(1)) {
      expect(piece.length).toBeGreaterThan(0);
      expect(piece.length).toBeLessThanOrEqual(320);
      expect(piece.length % cluster.length).toBe(0);
      expect(piece).not.toMatch(/[\ud800-\udfff]/u);
    }
    expect(out.join("")).toBe(text);
  });

  it("bounds a grapheme longer than the limit without splitting surrogate pairs", () => {
    const text = `𠮷${"\u0301".repeat(700)}`;
    const out = toUtterances(text, { maxChars: 319 });
    expect(out.length).toBeGreaterThan(1);
    for (const piece of out) {
      expect(piece.length).toBeGreaterThan(0);
      expect(piece.length).toBeLessThanOrEqual(319);
      expect(piece).not.toMatch(/[\ud800-\udfff]/u);
    }
    expect(out.join("")).toBe(text);
  });

  it("breaks a long Japanese reply at sentence ends, never mid-sentence", () => {
    // 33 units: a length that does not divide the 320 budget, so a cut would land mid-sentence.
    const sentence = "今日は晴れていて、散歩に行くのにちょうど良い天気になるでしょうね。";
    const text = sentence.repeat(12);
    const out = toUtterances(text);
    expect(out.length).toBeGreaterThan(1);
    for (const piece of out) {
      expect(piece.length).toBeLessThanOrEqual(320);
      expect(piece.endsWith("。")).toBe(true);
    }
    expect(out.join("")).toBe(text);
  });

  it("glues short Chinese sentences without inserting a space", () => {
    expect(toUtterances("你好。好的。")).toEqual(["你好。好的。"]);
  });

  it("does not glue short sentences past the limit", () => {
    const text = `${"a".repeat(319)}. Yes.`;
    expect(toUtterances(text)).toEqual([`${"a".repeat(319)}.`, "Yes."]);
  });

  it("keeps surrogate pairs intact on runtimes without Segmenter", () => {
    vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
    try {
      const text = "𠮷".repeat(1200);
      const out = toUtterances(text, { maxChars: 319 });
      expect(out.length).toBeGreaterThan(1);
      for (const piece of out) {
        expect(piece.length).toBeGreaterThan(0);
        expect(piece.length).toBeLessThanOrEqual(319);
        expect(piece).not.toMatch(/[\ud800-\udfff]/u);
      }
      expect(out.join("")).toBe(text);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves mixed Unicode text across different budgets", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("中", "あ", "𠮷", "e\u0301", "क्\u200dष", "葛\u{e0100}", "。"), {
          minLength: 1,
          maxLength: 800,
        }),
        fc.integer({ min: 2, max: 400 }),
        (characters, maxChars) => {
          const text = `中${characters.join("")}`;
          const out = toUtterances(text, { maxChars });
          expect(out.join("")).toBe(text);
          for (const piece of out) {
            expect(piece.length).toBeGreaterThan(0);
            expect(piece.length).toBeLessThanOrEqual(maxChars);
            expect(piece).not.toMatch(/[\ud800-\udfff]/u);
          }
        },
      ),
      { seed: 42, numRuns: 100 },
    );
  });

  it.each([1, 1.5])("rejects an unusable character budget of %s", (maxChars) => {
    expect(() => toUtterances("中".repeat(2400), { maxChars })).toThrow(RangeError);
  });

  it("runs its input through the spoken register first", () => {
    const out = toUtterances("Fixed it.\n\n```js\nconsole.log(1)\n```\n\nShipped.");
    expect(out.join(" ")).not.toContain("console.log");
  });

  it("is empty for text that speaks to nothing", () => {
    expect(toUtterances("```\ncode only\n```")).not.toContain("code only");
    expect(toUtterances("")).toEqual([]);
  });
});

describe("splitSentences", () => {
  it("keeps every sentence on its own, however short", () => {
    expect(splitSentences("Yes. The whole suite is green. Ship it?")).toEqual([
      "Yes.",
      "The whole suite is green.",
      "Ship it?",
    ]);
  });

  it("does not cut at abbreviations or decimals", () => {
    expect(splitSentences("I asked Dr. Lee about v2.5 e.g. the beta. Done.")).toEqual([
      "I asked Dr. Lee about v2.5 e.g. the beta.",
      "Done.",
    ]);
  });

  it("speaks markdown, so lines and headings end sentences and code is named", () => {
    expect(splitSentences("## Plan\n- Fix it\n- **Ship** it\n\n```ts\nx.y();\n```")).toEqual([
      "Plan.",
      "Fix it.",
      "Ship it.",
      "(a TypeScript code block)",
    ]);
  });

  it("splits Japanese and Chinese sentences after full-width punctuation with no space", () => {
    expect(
      splitSentences("今日は晴れです。明日は雨が降るでしょう。週末は曇りになりそうです。"),
    ).toEqual(["今日は晴れです。", "明日は雨が降るでしょう。", "週末は曇りになりそうです。"]);
    expect(splitSentences("你好！今天天气很好。我们走吧？")).toEqual([
      "你好！",
      "今天天气很好。",
      "我们走吧？",
    ]);
    expect(splitSentences("他停住了……然后走了。")).toEqual(["他停住了……", "然后走了。"]);
  });

  it("keeps closing quotes and brackets with the sentence they close", () => {
    expect(splitSentences("他说「好。」然后走了。")).toEqual(["他说「好。」", "然后走了。"]);
  });

  it("does not split a full-width period inside a number", () => {
    expect(splitSentences("版本１．５已发布。")).toEqual(["版本１．５已发布。"]);
  });

  it("leaves an unfinished sentence as the last piece", () => {
    expect(splitSentences("Booked for Friday. The hotel is")).toEqual([
      "Booked for Friday.",
      "The hotel is",
    ]);
    expect(splitSentences("")).toEqual([]);
  });
});

describe("sentenceKey", () => {
  it("matches a sentence however it is marked up or punctuated", () => {
    expect(sentenceKey("**Done.")).toBe(sentenceKey("Done."));
    expect(sentenceKey("All set, Ada!")).toBe("allsetada");
    expect(sentenceKey("Ça marche.")).toBe("çamarche");
    expect(sentenceKey("...")).toBe("");
  });
});

describe("narrateTool", () => {
  it("turns tool names into something worth hearing", () => {
    expect(narrateTool("Bash")).toBe("running a command");
    expect(narrateTool("Read")).toBe("reading a file");
    expect(narrateTool("Edit")).toBe("editing a file");
    expect(narrateTool("WebSearch")).toBe("searching the web");
    expect(narrateTool("screenshot")).toBe("looking at the screen");
    expect(narrateTool("computer_observe")).toBe("looking at the screen");
    expect(narrateTool("browser_snapshot")).toBe("using the page");
    expect(narrateTool("write_file")).toBe("writing a file");
    expect(narrateTool("run_subagent")).toBe("starting a subagent");
    expect(narrateTool("list_fleet")).toBe("checking your bots");
    expect(narrateTool("create_group")).toBe("creating a group");
    expect(narrateTool("update_group")).toBe("updating a group");
    expect(narrateTool("set_child_instructions")).toBe("rewriting a bot's instructions");
  });

  it("sees through an MCP tool prefix", () => {
    expect(narrateTool("mcp__computer__click")).toBe("using the computer");
    expect(narrateTool("mcp__agents__ask_bot")).toBe("asking a teammate");
  });

  it("stays quiet for chips the user is already told about another way", () => {
    expect(narrateTool("auto-approved Bash:git (always allowed)")).toBeNull();
    expect(narrateTool("error: claude exited 1")).toBeNull();
    expect(narrateTool("")).toBeNull();
  });

  it("falls back to naming an unknown tool, without reading its argv", () => {
    expect(narrateTool("deploy_thing")).toBe("running deploy_thing");
    expect(narrateTool('curl -X POST "https://x/y" --data @{}')).toBeNull();
  });
});

describe("spokenDecision", () => {
  it("accepts a clear yes or no and refuses a sentence that merely contains one", () => {
    expect(spokenDecision("yes")).toBe("yes");
    expect(spokenDecision("No thanks")).toBe("no");
    expect(spokenDecision("I'm sure that's fine, go look at the logs")).toBeNull();
    expect(spokenDecision("")).toBeNull();
  });

  it.each([
    ["Sí", "yes"],
    ["¡Sí, hazlo!", "yes"],
    ["Vale", "yes"],
    ["De acuerdo, adelante", "yes"],
    ["No, gracias", "no"],
    ["mejor no", "no"],
    ["Cancélalo", "no"],
  ])("hears the Spanish %j as %j", (said, decision) => {
    expect(spokenDecision(said)).toBe(decision);
  });

  it.each(["¿No?", "No?", "¿Sí", "si", "sí uno dos tres cuatro cinco seis"])(
    "does not approve or reject %j",
    (text) => expect(spokenDecision(text)).toBeNull(),
  );

  it("accepts accented sí", () => expect(spokenDecision("sí")).toBe("yes"));

  it.each([
    "okay, do not",
    "sure, cancel that",
    "yes but cancel it",
    "yes please don't",
    "ok stop",
    "yeah nah",
    "sí, mejor no",
  ])("does not pick a side when %j says both yes and no", (text) =>
    expect(spokenDecision(text)).toBeNull(),
  );

  it("still hears a plain yes or no that carries a polite extra", () => {
    expect(spokenDecision("yes please")).toBe("yes");
    expect(spokenDecision("ok, thanks")).toBe("yes");
    expect(spokenDecision("no thanks")).toBe("no");
  });

  it("keeps a refusal that repeats the action as a no", () => {
    expect(spokenDecision("don't do it")).toBe("no");
    expect(spokenDecision("no, do it later")).toBe("no");
  });

  it("hears a curly apostrophe like a straight one", () => {
    expect(spokenDecision("don’t")).toBe("no");
    expect(spokenDecision("don’t do it")).toBe("no");
    expect(spokenDecision("don't")).toBe("no");
  });

  it("does not hear a yes in a Spanish condition, question or instruction", () => {
    expect(spokenDecision("si puedes, revisa los logs")).toBeNull();
    expect(spokenDecision("sino revisa el deploy")).toBeNull();
    expect(spokenDecision("¿Sí? ¿Cuáles?")).toBeNull();
    expect(spokenDecision("dale los permisos de admin")).toBeNull();
  });
});
