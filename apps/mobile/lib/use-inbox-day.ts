import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { AppState } from "react-native";

/** Today's midnight, kept current while the inbox is in front so row times roll over. */
export function useInboxDay() {
  const [day, setDay] = useState(() => new Date().setHours(0, 0, 0, 0));
  useFocusEffect(
    useCallback(() => {
      let timer: ReturnType<typeof setTimeout>;
      const refreshDay = () => {
        clearTimeout(timer);
        const now = new Date();
        setDay(new Date(now).setHours(0, 0, 0, 0));
        const midnight = new Date(now);
        midnight.setHours(24, 0, 0, 0);
        timer = setTimeout(refreshDay, midnight.getTime() - now.getTime());
      };
      refreshDay();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") refreshDay();
      });
      return () => {
        clearTimeout(timer);
        subscription.remove();
      };
    }, []),
  );
  return day;
}
