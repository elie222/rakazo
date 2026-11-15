import type { NativeStackNavigationOptions } from "expo-router";
import { useNavigation } from "expo-router";
import { useLayoutEffect, useRef } from "react";
import { NativeActionButton } from "../components/native-action-button";
import { mobileTokens } from "./appearance";
import { iosAtLeast } from "./native-controls";

export type ScreenHeaderAction = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** A save in flight: the button shows disabled until it ends. */
  busy?: boolean;
  /** Primary unless named, as a header Save is. */
  prominence?: "primary" | "secondary" | "destructive";
};

/**
 * A screen's title and its one trailing header action: a native bar button on iOS 26, the plain
 * action button on Android and older iOS. The header is set again only when it would look
 * different, and a press always runs the handler of the latest render.
 *
 * A `title` left out keeps the one the layout gave the route. An `action` left out leaves the
 * trailing side alone; `null` clears the button this hook put there.
 */
export function useScreenHeader({
  title,
  action,
}: {
  title?: string;
  action?: ScreenHeaderAction | null;
}) {
  const navigation = useNavigation();
  const latest = useRef(action);
  useLayoutEffect(() => {
    latest.current = action;
  });

  const trailing = action === undefined ? "untouched" : action ? "shown" : "cleared";
  const label = action?.label ?? "";
  const inactive = Boolean(action?.disabled || action?.busy);
  const prominence = action?.prominence ?? "primary";

  useLayoutEffect(() => {
    if (title === undefined && trailing === "untouched") return;
    const options: NativeStackNavigationOptions = title === undefined ? {} : { title };
    const press = () => {
      const now = latest.current;
      if (now && !now.disabled && !now.busy) now.onPress();
    };
    if (trailing === "cleared") {
      if (iosAtLeast(26)) options.unstable_headerRightItems = undefined;
      else options.headerRight = undefined;
    } else if (trailing === "shown" && iosAtLeast(26)) {
      options.unstable_headerRightItems = () => [
        {
          type: "button" as const,
          label,
          ...(prominence === "destructive"
            ? { tintColor: mobileTokens().destructive }
            : prominence === "primary"
              ? { variant: "prominent" as const, tintColor: mobileTokens().primary }
              : {}),
          disabled: inactive,
          onPress: press,
        },
      ];
    } else if (trailing === "shown") {
      options.headerRight = () => (
        <NativeActionButton
          disabled={inactive}
          fill={false}
          label={label}
          onPress={press}
          prominence={prominence}
        />
      );
    }
    navigation.setOptions(options);
  }, [navigation, title, trailing, label, inactive, prominence]);
}
