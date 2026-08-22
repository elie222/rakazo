import { describe, expect, it } from "vitest";
import { matchingAskOption, parseAskOptions } from "./ask-options.js";

describe("parseAskOptions", () => {
  it("uses explicit actions when provided", () => {
    expect(
      parseAskOptions({
        text: "Let him pay at pickup?",
        actions: [
          { id: "yes", label: "Yes, pay at pickup" },
          { id: "no", label: "No, pay first" },
          { id: "me", label: "I'll handle him" },
        ],
      }),
    ).toEqual({
      question: "Let him pay at pickup?",
      options: [
        { id: "yes", letter: "A", label: "Yes, pay at pickup" },
        { id: "no", letter: "B", label: "No, pay first" },
        { id: "me", letter: "C", label: "I'll handle him" },
      ],
    });
  });

  it("does not mistake an explicit A-or-B question for an option line", () => {
    expect(
      parseAskOptions({
        text: "A or B?",
        actions: [
          { id: "a", label: "Choose A" },
          { id: "b", label: "Choose B" },
        ],
      }).question,
    ).toBe("A or B?");
  });

  it("removes duplicated option lines when explicit actions are provided", () => {
    expect(
      parseAskOptions({
        text: "Choose a region\nA. US\nB. EU",
        actions: [
          { id: "us", label: "US" },
          { id: "eu", label: "EU" },
        ],
      }).question,
    ).toBe("Choose a region");
  });

  it("parses lettered options out of the ask text", () => {
    const parsed = parseAskOptions({
      text: "Let him pay at pickup?\nA Yes, pay at pickup\nB No, pay first\nC I'll handle him.",
    });
    expect(parsed.question).toBe("Let him pay at pickup?");
    expect(parsed.options.map((option) => option.label)).toEqual([
      "Yes, pay at pickup",
      "No, pay first",
      "I'll handle him.",
    ]);
  });

  it("keeps detail out of the question when it is not an option list", () => {
    expect(
      parseAskOptions({
        text: "Which city should I use?",
        detail: "Reply with one city name.",
      }),
    ).toEqual({
      question: "Which city should I use?",
      options: [],
    });
  });

  it("does not repeat a question duplicated in the detail", () => {
    expect(
      parseAskOptions({
        text: "Which region should I use?",
        detail: "Which region should I use?\nA. US\nB. EU",
      }),
    ).toEqual({
      question: "Which region should I use?",
      options: [
        { id: "A", letter: "A", label: "US" },
        { id: "B", letter: "B", label: "EU" },
      ],
    });
  });
});

describe("matchingAskOption", () => {
  const options = parseAskOptions({
    text: "Ship it?",
    actions: [
      { id: "send", label: "Send it" },
      { id: "edit", label: "Edit first" },
    ],
  }).options;

  it("matches the id, label, letter, punctuation, or combined answer", () => {
    expect(matchingAskOption(options, "b")?.label).toBe("Edit first");
    expect(matchingAskOption(options, "send")?.label).toBe("Send it");
    expect(matchingAskOption(options, "Send it")?.letter).toBe("A");
    expect(matchingAskOption(options, "B.")?.label).toBe("Edit first");
    expect(matchingAskOption(options, "A Send it")?.id).toBe("send");
  });
});
