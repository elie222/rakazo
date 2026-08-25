import { describe, expect, it } from "vitest";
import { localizeAgentActivity } from "./ui-activity";

describe("localizeAgentActivity", () => {
  it("localizes built-in tool activity while preserving paths", () => {
    expect(localizeAgentActivity("Remember", "ko-KR")).toBe("기억");
    expect(localizeAgentActivity("Saving a note to memory", "ko-KR")).toBe("기억해두는 중");
    expect(localizeAgentActivity("Reading /srv/data/notes.md", "ko-KR")).toBe(
      "/srv/data/notes.md 읽는 중",
    );
  });

  it("keeps model prose and unsupported locales unchanged", () => {
    expect(localizeAgentActivity("Saving a note to memory", "en-US")).toBe(
      "Saving a note to memory",
    );
    expect(localizeAgentActivity("사용자가 작성한 일반 문장", "ko-KR")).toBe(
      "사용자가 작성한 일반 문장",
    );
  });
});
