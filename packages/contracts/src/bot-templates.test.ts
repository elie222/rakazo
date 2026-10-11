import { describe, expect, it } from "vitest";
import { searchBotTemplates } from "./bot-templates.js";

describe("template search", () => {
  const templates = [
    {
      slug: "inbox",
      name: "Inbox Manager",
      description: "Organize email",
      instructions: "Ask about folders.",
      featured: true,
    },
    {
      slug: "research",
      name: "Research",
      description: "Write briefs",
      instructions: "Ask about subjects.",
      featured: false,
    },
  ];
  it("matches words across name and description regardless of case or whitespace", () => {
    expect(searchBotTemplates(templates, "  EMAIL  inbox ")).toEqual([templates[0]]);
    expect(searchBotTemplates(templates, "briefs")).toEqual([templates[1]]);
    expect(searchBotTemplates(templates, "")).toEqual(templates);
    expect(searchBotTemplates(templates, "missing")).toEqual([]);
  });
});
