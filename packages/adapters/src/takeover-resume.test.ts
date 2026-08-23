import { describe, expect, it } from "vitest";
import { takeoverResumeFromRelease } from "./takeover-resume.js";

describe("takeoverResumeFromRelease", () => {
  it("tells the bot the login finished after I'm done or a plain release", () => {
    for (const reason of ["done", "released", undefined]) {
      const resume = takeoverResumeFromRelease(reason);
      expect(resume.checkpoint).toBe("takeover");
      expect(resume.promptNote).toMatch(/finished the login/i);
    }
  });

  it("tells the bot the login was skipped", () => {
    const resume = takeoverResumeFromRelease("skipped");
    expect(resume.checkpoint).toBe("takeover-skipped");
    expect(resume.promptNote).toMatch(/skipped the login/i);
    expect(resume.promptNote).not.toMatch(/finished the login/i);
  });

  it("treats an expired takeover like a skip", () => {
    expect(takeoverResumeFromRelease("expired").checkpoint).toBe("takeover-skipped");
  });
});
