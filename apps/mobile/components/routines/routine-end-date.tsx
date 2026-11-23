import { useLingui } from "@lingui/react/macro";
import { SettingsDateRow, settingsDateRowAvailable } from "../settings/settings-date-row";
import { SettingsGroup, SettingsSwitch } from "../settings/settings-group";

export function RoutineEndDate({
  endsOn,
  today,
  firstDay,
  onChange,
}: {
  endsOn: string;
  today: string;
  firstDay: string;
  onChange: (endsOn: string) => void;
}) {
  const { t } = useLingui();
  if (!settingsDateRowAvailable()) return null;
  return (
    <SettingsGroup>
      <SettingsSwitch
        label={t`End date`}
        value={Boolean(endsOn)}
        onChange={(on) => onChange(on ? firstDay : "")}
      />
      {endsOn ? (
        <SettingsDateRow title={t`Ends`} day={endsOn} minimumDay={today} onChange={onChange} />
      ) : null}
    </SettingsGroup>
  );
}
