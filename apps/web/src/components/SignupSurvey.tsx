import { Trans, useLingui } from "@lingui/react/macro";
import type { SignupSurvey as SignupSurveyAnswers } from "@rakazo/contracts";
import { SIGNUP_SURVEY_TEAM_SIZES, signupSurveyAsksTeamSize } from "@rakazo/contracts";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import { useId, useState } from "react";
import { rpc } from "../lib/rpc";

type Use = NonNullable<SignupSurveyAnswers["use"]>;
type TeamSize = NonNullable<SignupSurveyAnswers["teamSize"]>;

const TEAM_SIZE_LABELS: Record<TeamSize, string> = {
  "1": "1",
  "2-10": "2–10",
  "11-50": "11–50",
  "51-200": "51–200",
  "201+": "200+",
};

export function SignupSurvey({ onDone }: { onDone: () => void }) {
  const { t } = useLingui();
  const fieldId = useId();
  const [reason, setReason] = useState("");
  const [use, setUse] = useState<Use | null>(null);
  const [teamSize, setTeamSize] = useState<TeamSize | null>(null);
  const [source, setSource] = useState("");

  function submit() {
    // Answers are optional, so a slow or failed save never holds up onboarding.
    void rpc.onboarding
      .signupSurvey({
        reason: reason.trim() || undefined,
        use: use ?? undefined,
        teamSize: signupSurveyAsksTeamSize(use ?? undefined) ? (teamSize ?? undefined) : undefined,
        source: source.trim() || undefined,
      })
      .catch(() => undefined);
    onDone();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h1 className="text-[32px] font-medium text-foreground">
        <Trans>Welcome to Rakazo</Trans>
      </h1>
      <p id={`${fieldId}-use`} className="mt-8 text-sm font-medium text-foreground">
        <Trans>How will you use Rakazo?</Trans>
      </p>
      <ToggleGroup
        aria-labelledby={`${fieldId}-use`}
        value={use ? [use] : []}
        onValueChange={([next]) => setUse((next as Use | undefined) ?? null)}
        spacing={1}
        className="mt-2 grid w-full grid-cols-3 rounded-lg bg-muted p-1"
      >
        <ToggleGroupItem
          value="personal"
          className="aria-pressed:bg-background aria-pressed:shadow-sm"
        >
          <Trans>Personal</Trans>
        </ToggleGroupItem>
        <ToggleGroupItem value="work" className="aria-pressed:bg-background aria-pressed:shadow-sm">
          <Trans>Work</Trans>
        </ToggleGroupItem>
        <ToggleGroupItem value="both" className="aria-pressed:bg-background aria-pressed:shadow-sm">
          <Trans>Both</Trans>
        </ToggleGroupItem>
      </ToggleGroup>
      {signupSurveyAsksTeamSize(use ?? undefined) ? (
        <div className="mt-6 text-sm font-medium text-foreground">
          <span>
            <Trans>How big is your team?</Trans>
          </span>
          <Select
            value={teamSize}
            onValueChange={(value) => setTeamSize((value as TeamSize | null) ?? null)}
            items={SIGNUP_SURVEY_TEAM_SIZES.map((size) => ({
              value: size,
              label: TEAM_SIZE_LABELS[size],
            }))}
          >
            <SelectTrigger aria-label={t`How big is your team?`} className="mt-2 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SIGNUP_SURVEY_TEAM_SIZES.map((size) => (
                <SelectItem key={size} value={size}>
                  {TEAM_SIZE_LABELS[size]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <label
        htmlFor={`${fieldId}-source`}
        className="mt-6 block text-sm font-medium text-foreground"
      >
        <Trans>How did you hear about us?</Trans>
      </label>
      <Input
        id={`${fieldId}-source`}
        value={source}
        onChange={(event) => setSource(event.target.value)}
        maxLength={500}
        className="mt-2"
      />
      <label
        htmlFor={`${fieldId}-reason`}
        className="mt-6 block text-sm font-medium text-foreground"
      >
        <Trans>What do you most want Rakazo to help with?</Trans>
      </label>
      <Textarea
        id={`${fieldId}-reason`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={2000}
        rows={3}
        placeholder={t`Optional`}
        className="mt-2"
      />
      <Button type="submit" className="mt-8">
        <Trans>Continue</Trans>
      </Button>
    </form>
  );
}
