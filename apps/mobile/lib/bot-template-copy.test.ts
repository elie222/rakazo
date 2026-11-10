import { BOT_TEMPLATES } from "@rakazo/core";
import { afterEach, describe, expect, it } from "vitest";
import { botTemplateCopy } from "./bot-template-copy";
import { resetI18nForTests } from "./i18n";

afterEach(() => resetI18nForTests());

describe("botTemplateCopy", () => {
  it("matches the server's English for every template", () => {
    resetI18nForTests("en");
    for (const template of BOT_TEMPLATES) {
      expect(botTemplateCopy(template)).toEqual({
        name: template.name,
        summary: template.summary,
        sample: template.sample,
      });
    }
  });

  it("translates every template", () => {
    resetI18nForTests("de");
    for (const template of BOT_TEMPLATES) {
      const copy = botTemplateCopy(template);
      expect(copy.summary).not.toBe(template.summary);
      expect(copy.sample).not.toBe(template.sample);
    }
  });

  it("shows the server's English for a template it does not know", () => {
    resetI18nForTests("de");
    const template = { ...BOT_TEMPLATES[0]!, id: "new-template", name: "New", summary: "S" };
    expect(botTemplateCopy(template)).toMatchObject({ name: "New", summary: "S" });
  });
});
