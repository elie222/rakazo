import { useLingui } from "@lingui/react/macro";
import { useDateLocale } from "../../lib/i18n/i18n";
import { formatCalendarDay } from "../../lib/native/calendar-day";
import { SettingsDateRow, settingsDateRowAvailable } from "../settings/settings-date-row";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "../settings/settings-group";

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
  const dateLocale = useDateLocale();
  const pickable = settingsDateRowAvailable();
  if (!pickable && !endsOn) return null;
  return (
    <SettingsGroup>
      <SettingsSwitch
        label={t`End date`}
        value={Boolean(endsOn)}
        onChange={(on) => onChange(on ? firstDay : "")}
      />
      {!endsOn ? null : pickable ? (
        <SettingsDateRow title={t`Ends`} day={endsOn} minimumDay={today} onChange={onChange} />
      ) : (
        <SettingsRow title={t`Ends`} value={formatCalendarDay(endsOn, dateLocale)} />
      )}
    </SettingsGroup>
  );
}
