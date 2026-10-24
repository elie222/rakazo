import type { SignupSurvey } from "@rakazo/contracts";
import {
  SIGNUP_SURVEY_TEAM_SIZES,
  signupSurveyAsksTeamSize,
  signupSurveyTeamSizeLabel,
} from "@rakazo/contracts";

export type SignupSurveyTeamSize = (typeof SIGNUP_SURVEY_TEAM_SIZES)[number];

export const SIGNUP_SURVEY_TEAM_SIZE_CHOICES = SIGNUP_SURVEY_TEAM_SIZES.map((key) => ({
  key,
  label: signupSurveyTeamSizeLabel(key),
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
