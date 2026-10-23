import { describe, expect, it } from "vitest";
import { SIGNUP_SURVEY_TEAM_SIZE_CHOICES, signupSurveyAnswers } from "./signup-survey";

describe("signup survey answers", () => {
  it("sends an empty survey when everything is blank", () => {
    expect(signupSurveyAnswers({ reason: "  ", source: "" })).toEqual({});
  });

  it("trims answers and keeps team size for work", () => {
    expect(
      signupSurveyAnswers({
        reason: "  Triage support email ",
        use: "work",
        teamSize: "11-50",
        source: " A friend ",
      }),
    ).toEqual({
      reason: "Triage support email",
      use: "work",
      teamSize: "11-50",
      source: "A friend",
    });
  });

  it("keeps team size for both", () => {
    expect(signupSurveyAnswers({ reason: "", use: "both", teamSize: "2-10", source: "" })).toEqual({
      use: "both",
      teamSize: "2-10",
    });
  });

  it("drops a team size picked before switching to personal", () => {
    expect(
      signupSurveyAnswers({ reason: "", use: "personal", teamSize: "2-10", source: "" }),
    ).toEqual({ use: "personal" });
  });

  it("labels team sizes with en dashes and 200+", () => {
    expect(SIGNUP_SURVEY_TEAM_SIZE_CHOICES.map((choice) => choice.label)).toEqual([
      "1",
      "2–10",
      "11–50",
      "51–200",
      "200+",
    ]);
  });
});
