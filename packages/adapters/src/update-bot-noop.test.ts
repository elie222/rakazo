import { describe, expect, it } from "vitest";
import {
  dropUnchangedOwnBotArgs,
  ignoredFieldsNote,
  splitUpdateBotChange,
} from "./update-bot-patch.js";

const current = {
  name: "Helper",
  description: "Answers on a chat app.",
  instructions: "Be brief.",
  color: "#22C55E",
  notifyOnFinish: false,
  dailyCheckIns: false,
  thinkingLevel: "high",
  autoSpeak: false,
  voiceId: null,
};

describe("dropUnchangedOwnBotArgs", () => {
  it("turns a call that repeats every current value into a read", () => {
    expect(
      dropUnchangedOwnBotArgs(
        {
          name: "Helper",
          description: " Answers on a chat app. ",
          instructions: "Be brief.",
          color: "#22C55E",
          notifyOnFinish: false,
          dailyCheckIns: false,
          thinkingLevel: "high",
          readAloud: false,
          voice: "default",
          use_attached_image: false,
          instructions_offset: 0,
        },
        current,
      ),
    ).toEqual({});
  });

  it("treats every name of the current model and the run's thinking as no change", () => {
    const names = ["gpt-fixture", "openai-compatible/gpt-fixture", "gpt-fixture (Compatible)"];
    for (const model of [...names, "GPT-fixture (compatible)"])
      expect(
        dropUnchangedOwnBotArgs(
          { model, thinkingLevel: "medium" },
          { ...current, thinkingLevel: null },
          names,
          "medium",
        ),
      ).toEqual({});
  });

  it("keeps the same model id at another provider", () => {
    expect(
      dropUnchangedOwnBotArgs({ model: "openrouter/gpt-fixture" }, current, [
        "gpt-fixture",
        "openai-compatible/gpt-fixture",
      ]),
    ).toEqual({ model: "openrouter/gpt-fixture" });
  });

  it("treats default thinking as no change for a bot without its own level", () => {
    expect(
      dropUnchangedOwnBotArgs(
        { thinkingLevel: "default" },
        { ...current, thinkingLevel: null },
        [],
        "medium",
      ),
    ).toEqual({});
  });

  it("reads switches sent as text and the default thinking level", () => {
    expect(
      dropUnchangedOwnBotArgs(
        { dailyCheckIns: "false", notifyOnFinish: "true", thinkingLevel: "default" },
        { ...current, thinkingLevel: null },
      ),
    ).toEqual({ notifyOnFinish: true });
  });

  it("keeps real changes", () => {
    expect(
      dropUnchangedOwnBotArgs(
        { thinkingLevel: "max", readAloud: true, use_attached_image: true, model: "gpt-fixture" },
        current,
        ["openai-compatible/gpt-other", "gpt-other"],
      ),
    ).toEqual({
      thinkingLevel: "max",
      readAloud: true,
      use_attached_image: true,
      model: "gpt-fixture",
    });
  });
});

describe("ignoredFieldsNote", () => {
  it("names a bounded number of fields with short previews", () => {
    const fields = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`field${i}`, "x".repeat(5000)]),
    );
    const note = ignoredFieldsNote({ ...fields, blank: "", none: null });
    expect(note).toContain("field0=");
    expect(note).toContain("and 4 more");
    expect(note).not.toContain("blank");
    expect(note!.length).toBeLessThan(1000);
    expect(ignoredFieldsNote({ name: "" })).toBeUndefined();
    expect(ignoredFieldsNote({ readAloud: false }, "unlisted")).toBe(
      "These were not listed in change, so they were not applied: readAloud=false. To change one, list it in change.",
    );
  });
});

describe("splitUpdateBotChange", () => {
  // A model asked which model it runs sent every field, switches off.
  const filled = {
    thinkingLevel: "off",
    notifyOnFinish: false,
    dailyCheckIns: false,
    readAloud: false,
    use_attached_image: false,
    model: "gpt-fixture",
    instructions_offset: 800,
    bot_id: "",
  };

  it("applies no setting without change and keeps what it did not apply apart", () => {
    expect(splitUpdateBotChange(filled)).toEqual({
      args: { instructions_offset: 800, bot_id: "" },
      unlisted: {
        thinkingLevel: "off",
        notifyOnFinish: false,
        dailyCheckIns: false,
        readAloud: false,
        model: "gpt-fixture",
      },
    });
  });

  it("applies the fields listed in change", () => {
    expect(splitUpdateBotChange({ ...filled, change: ["model", "notifyOnFinish"] })).toEqual({
      args: { model: "gpt-fixture", notifyOnFinish: false, instructions_offset: 800, bot_id: "" },
      unlisted: { thinkingLevel: "off", dailyCheckIns: false, readAloud: false },
    });
    expect(splitUpdateBotChange({ notify_on_finish: true, change: ["notifyOnFinish"] })).toEqual({
      args: { notify_on_finish: true },
      unlisted: undefined,
    });
  });

  it("ignores unknown names in change and takes a single name sent as a string", () => {
    expect(splitUpdateBotChange({ name: "Scout", change: ["name", "fleetManagement"] })).toEqual({
      args: { name: "Scout" },
      unlisted: undefined,
    });
    expect(splitUpdateBotChange({ change: "name", name: "Scout", color: "#0a0" })).toEqual({
      args: { name: "Scout" },
      unlisted: { color: "#0a0" },
    });
    expect(splitUpdateBotChange({ change: 3, name: "Scout" })).toEqual({
      args: {},
      unlisted: { name: "Scout" },
    });
  });

  it("matches the notify-on-finish alias whichever spelling change lists", () => {
    expect(splitUpdateBotChange({ notifyOnFinish: true, change: ["notify_on_finish"] })).toEqual({
      args: { notifyOnFinish: true },
      unlisted: undefined,
    });
  });
});
