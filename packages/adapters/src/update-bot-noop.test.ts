import { describe, expect, it } from "vitest";
import { dropUnchangedOwnBotArgs } from "./update-bot-patch.js";

const current = {
  name: "Helper",
  description: "Answers on a chat app.",
  instructions: "Be brief.",
  color: "#22C55E",
  notifyOnFinish: false,
  dailyCheckIns: false,
  modelId: null,
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

  it("treats the model and thinking this run uses as the bot's own when it is on the defaults", () => {
    expect(
      dropUnchangedOwnBotArgs(
        { model: "openai-compatible/gpt-fixture", thinkingLevel: "medium" },
        { ...current, thinkingLevel: null },
        { modelId: "gpt-fixture", thinkingLevel: "medium" },
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
      ),
    ).toEqual({
      thinkingLevel: "max",
      readAloud: true,
      use_attached_image: true,
      model: "gpt-fixture",
    });
  });
});
