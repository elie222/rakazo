import { describe, expect, it } from "vitest";
import { botProfileUpdate } from "./bot-profile";

describe("botProfileUpdate", () => {
  it("keeps profile fields independent when saving", () => {
    expect(
      botProfileUpdate({
        name: "Maya",
        title: "Marketing Expert",
        description: "Short profile summary",
        instructions: "Detailed operating instructions",
        color: "#9B5CF6",
        sectionId: "grow-section",
      }),
    ).toEqual({
      name: "Maya",
      title: "Marketing Expert",
      description: "Short profile summary",
      instructions: "Detailed operating instructions",
      color: "#9B5CF6",
      sectionId: "grow-section",
    });
  });
});
