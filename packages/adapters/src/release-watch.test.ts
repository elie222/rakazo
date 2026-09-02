import { describe, expect, it } from "vitest";
import {
  assessReleaseWatchRoutinePrompt,
  diagnoseReleaseWatchRun,
  RELEASE_WATCH_EVAL_DEFAULT_MODEL_ID,
  RELEASE_WATCH_EVAL_MODEL_LABEL,
  RELEASE_WATCH_GITHUB_TOOL_NAMES,
  resolveReleaseWatchEvalModelId,
} from "./release-watch.js";

describe("release-watch diagnosis", () => {
  it("maps GPT 5.6 Luna to the in-repo OpenRouter/Pi model id without inventing a lock", () => {
    expect(RELEASE_WATCH_EVAL_MODEL_LABEL).toBe("GPT 5.6 Luna");
    expect(RELEASE_WATCH_EVAL_DEFAULT_MODEL_ID).toBe("openai/gpt-5.6-luna");
    expect(resolveReleaseWatchEvalModelId({}).modelId).toBe("openai/gpt-5.6-luna");
    expect(
      resolveReleaseWatchEvalModelId({ RELEASE_WATCH_EVAL_MODEL: " provider/custom-luna " })
        .modelId,
    ).toBe("provider/custom-luna");
  });

  it("flags vague routine prompts and accepts concrete GitHub tool steps", () => {
    expect(assessReleaseWatchRoutinePrompt("check updates").diagnosis).toBe("vague_routine_prompt");
    expect(
      assessReleaseWatchRoutinePrompt(
        "Open Bing and search for rakazo releases on the computer browser.",
      ).diagnosis,
    ).toBe("browser_used_instead_of_integrations");

    const good = assessReleaseWatchRoutinePrompt(
      [
        "Daily: use GITHUB_LIST_RELEASES for owner elie222 repo rakazo.",
        "Summarize new release tags and capability notes from release bodies.",
        "Prefer the GitHub plugin tools; do not browse or Bing-search.",
      ].join(" "),
    );
    expect(good).toMatchObject({ ok: true, diagnosis: "ok" });
  });

  it("diagnoses missing tools, browser fallback, and missing release info distinctly", () => {
    const missingTools = diagnoseReleaseWatchRun({
      availableToolNames: ["computer_observe", "computer_act"],
      calledToolNames: ["computer_act"],
      routinePrompt: "Stay current on rakazo somehow.",
      resultText: "I searched Bing and hit an error.",
      seededReleaseTags: ["v0.4.2"],
    });
    expect(missingTools.pass).toBe(false);
    expect(missingTools.diagnoses).toEqual(
      expect.arrayContaining([
        "vague_routine_prompt",
        "missing_github_tools",
        "browser_used_instead_of_integrations",
        "no_release_info_retrieved",
      ]),
    );
    expect(missingTools.summary).toMatch(/vague_routine_prompt/);
    expect(missingTools.summary).toMatch(/missing_github_tools/);
    expect(missingTools.summary).toMatch(/browser_used_instead_of_integrations/);

    const pass = diagnoseReleaseWatchRun({
      availableToolNames: [...RELEASE_WATCH_GITHUB_TOOL_NAMES],
      calledToolNames: ["GITHUB_LIST_RELEASES"],
      routinePrompt:
        "Call GITHUB_LIST_RELEASES for elie222/rakazo and summarize new releases and capabilities.",
      resultText: "Latest is v0.4.2 with routine tools + connector emulators.",
      seededReleaseTags: ["v0.4.2"],
    });
    expect(pass).toEqual({
      pass: true,
      diagnoses: ["ok"],
      summary: "Release watch used GitHub tools successfully.",
    });
  });
});
