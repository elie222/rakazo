import { lazy, Suspense, useState } from "react";
import { Platform } from "react-native";
import { useDateLocale } from "../../lib/i18n/i18n";
import { formatCalendarDay } from "../../lib/native/calendar-day";
import { isComposeViewAvailable } from "../../lib/native/compose-available";
import type { SettingsDateRowProps } from "./settings-date-row-props";
import { SettingsRow } from "./settings-group";

const ComposeDateDialog = lazy(() => import("./settings-date-dialog-compose"));

export function settingsDateRowAvailable(): boolean {
  return (
    Platform.OS === "android" &&
    isComposeViewAvailable("HostView") &&
    isComposeViewAvailable("DatePickerDialogView")
  );
}

export function SettingsDateRow({ title, day, minimumDay, onChange }: SettingsDateRowProps) {
  const dateLocale = useDateLocale();
  const [open, setOpen] = useState(false);
  const shown = formatCalendarDay(day, dateLocale);
  return (
    <>
      <SettingsRow title={title} value={shown} onPress={() => setOpen(true)} />
      {open ? (
        <Suspense fallback={null}>
          <ComposeDateDialog
            day={day}
            minimumDay={minimumDay}
            onChange={(picked) => {
              setOpen(false);
              onChange(picked);
            }}
            onDismiss={() => setOpen(false)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
