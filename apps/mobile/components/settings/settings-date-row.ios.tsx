import { DatePicker, Host } from "@expo/ui/swift-ui";
import { accessibilityLabel, datePickerStyle, labelsHidden } from "@expo/ui/swift-ui/modifiers";
import { dayOfLocalDate, localDateOfDay } from "../../lib/native/calendar-day";
import { useResolvedAppearance } from "../../lib/native/native";
import type { SettingsDateRowProps } from "./settings-date-row-props";
import { SettingsRow } from "./settings-group";

export function settingsDateRowAvailable(): boolean {
  return true;
}

export function SettingsDateRow({ title, day, minimumDay, onChange }: SettingsDateRowProps) {
  const scheme = useResolvedAppearance();
  return (
    <SettingsRow
      title={title}
      trailing={
        <Host colorScheme={scheme} ignoreSafeArea="container" matchContents>
          <DatePicker
            title={title}
            selection={localDateOfDay(day)}
            displayedComponents={["date"]}
            range={minimumDay ? { start: localDateOfDay(minimumDay) } : undefined}
            onDateChange={(date) => onChange(dayOfLocalDate(date))}
            modifiers={[datePickerStyle("compact"), labelsHidden(), accessibilityLabel(title)]}
          />
        </Host>
      }
    />
  );
}
