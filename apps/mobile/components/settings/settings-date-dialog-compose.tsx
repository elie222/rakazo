import { DatePickerDialog, Host } from "@expo/ui/jetpack-compose";
import { dayOfUtcDate, localDateOfDay } from "../../lib/native/calendar-day";

export default function ComposeDateDialog({
  day,
  minimumDay,
  onChange,
  onDismiss,
}: {
  day: string;
  minimumDay?: string;
  onChange: (day: string) => void;
  onDismiss: () => void;
}) {
  return (
    <Host>
      <DatePickerDialog
        initialDate={`${day}T00:00:00.000Z`}
        selectableDates={minimumDay ? { start: localDateOfDay(minimumDay) } : undefined}
        onDateSelected={(date) => onChange(dayOfUtcDate(date))}
        onDismissRequest={onDismiss}
      />
    </Host>
  );
}
