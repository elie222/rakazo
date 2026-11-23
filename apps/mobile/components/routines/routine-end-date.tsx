import { useLingui } from "@lingui/react/macro";
import { dayOfLocalDate } from "../../lib/native/calendar-day";
import { SettingsDateRow, settingsDateRowAvailable } from "../settings/settings-date-row";
import { SettingsGroup, SettingsSwitch } from "../settings/settings-group";

const WEEK_MS = 7 * 86_400_000;

export function RoutineEndDate({
  endsOn,
  onChange,
}: {
  endsOn: string;
  onChange: (endsOn: string) => void;
}) {
  const { t } = useLingui();
  if (!settingsDateRowAvailable()) return null;
  return (
    <SettingsGroup>
      <SettingsSwitch
        label={t`End date`}
        value={Boolean(endsOn)}
        onChange={(on) => onChange(on ? dayOfLocalDate(new Date(Date.now() + WEEK_MS)) : "")}
      />
      {endsOn ? (
        <SettingsDateRow
          title={t`Ends`}
          day={endsOn}
          minimumDay={dayOfLocalDate(new Date())}
          onChange={onChange}
        />
      ) : null}
    </SettingsGroup>
  );
}
