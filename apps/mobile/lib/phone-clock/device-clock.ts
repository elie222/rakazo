import { t } from "@lingui/core/macro";
import { NativeClockOperation, NativeClockResponse } from "@rakazo/contracts";
import { requireOptionalNativeModule } from "expo-modules-core";
import { Alert, AppState, Platform } from "react-native";
import { dateLocaleForUi } from "../i18n/i18n";

type AndroidClock = {
  startTimer(durationSeconds: number, label: string | null): Promise<string>;
  setAlarm(hour: number, minute: number, label: string | null): Promise<string>;
};
type PreparedClock = { perform: () => Promise<NativeClockResponse> } | NativeClockResponse;

function deviceClock() {
  return Platform.OS === "android"
    ? requireOptionalNativeModule<AndroidClock>("RakazoClock")
    : null;
}

function timerDuration(seconds: number, locale: string): string {
  const units = [
    [Math.floor(seconds / 3600), "hour"],
    [Math.floor((seconds % 3600) / 60), "minute"],
    [seconds % 60, "second"],
  ] as const;
  return units
    .filter(([value]) => value > 0)
    .map(([value, unit]) => new Intl.NumberFormat(locale, { style: "unit", unit }).format(value))
    .join(" ");
}

export async function prepareDeviceClock(
  operation: NativeClockOperation,
  current: () => boolean,
): Promise<PreparedClock> {
  const active = () => current() && AppState.currentState === "active";
  if (!active()) return { status: "unavailable" };
  const clock = deviceClock();
  const parsed = NativeClockOperation.safeParse(operation);
  if (!clock || !parsed.success) return { status: "unavailable" };

  const { action, input } = parsed.data;
  const timer = action === "start_phone_timer";
  const locale = dateLocaleForUi();
  const time = timer
    ? timerDuration(input.durationSeconds, locale)
    : new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: "UTC" }).format(
        Date.UTC(1970, 0, 1, input.hour, input.minute),
      );
  const title = timer ? t`Open Clock to start a timer?` : t`Open Clock to set an alarm?`;
  const accepted = await new Promise<boolean>((resolve) => {
    Alert.alert(
      title,
      input.label ? `${time}\n${input.label}` : time,
      [
        { text: t`Cancel`, style: "cancel", onPress: () => resolve(false) },
        { text: t`Open Clock`, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
  if (!accepted) return { status: "cancelled" };

  return {
    perform: async () => {
      if (!active()) return { status: "unavailable" };
      try {
        const status = timer
          ? await clock.startTimer(input.durationSeconds, input.label ?? null)
          : await clock.setAlarm(input.hour, input.minute, input.label ?? null);
        const response = NativeClockResponse.safeParse({ status });
        // Opening Clock can move Rakazo to the background before this receipt arrives.
        return response.success ? response.data : { status: "uncertain" };
      } catch {
        return { status: "uncertain" };
      }
    },
  };
}
