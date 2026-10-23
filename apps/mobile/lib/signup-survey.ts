import type { SignupSurvey } from "@rakazo/contracts";
import { SIGNUP_SURVEY_TEAM_SIZES, signupSurveyAsksTeamSize } from "@rakazo/contracts";

export type SignupSurveyTeamSize = (typeof SIGNUP_SURVEY_TEAM_SIZES)[number];

/** Team sizes as shown: en dashes for ranges, and the open-ended bucket as "200+". */
export const SIGNUP_SURVEY_TEAM_SIZE_CHOICES = SIGNUP_SURVEY_TEAM_SIZES.map((key) => ({
  key,
  label: key === "201+" ? "200+" : key.replace("-", "–"),
}));

/** Trimmed answers with blanks left out; team size only counts when it was asked. */
export function signupSurveyAnswers(form: {
  reason: string;
  use?: SignupSurvey["use"];
  teamSize?: SignupSurveyTeamSize;
  source: string;
}): SignupSurvey {
  const reason = form.reason.trim();
  const source = form.source.trim();
  return {
    ...(reason ? { reason } : {}),
    ...(form.use ? { use: form.use } : {}),
    ...(signupSurveyAsksTeamSize(form.use) && form.teamSize ? { teamSize: form.teamSize } : {}),
    ...(source ? { source } : {}),
  };
}
