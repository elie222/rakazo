import { describe, expect, it } from "vitest";
import { localizeVoiceCopy } from "./ui-voice-copy";

describe("localizeVoiceCopy", () => {
  it("localizes known provider descriptions", () => {
    expect(
      localizeVoiceCopy(
        "Highest quality and cloning. Flash v2.5 for conversational calls.",
        "ko-KR",
      ),
    ).toContain("고품질 음성");
  });

  it("preserves product copy for English and unknown descriptions", () => {
    expect(localizeVoiceCopy("Unknown provider", "ko-KR")).toBe("Unknown provider");
    expect(localizeVoiceCopy("Highest quality and cloning.", "en-US")).toBe(
      "Highest quality and cloning.",
    );
  });
});
