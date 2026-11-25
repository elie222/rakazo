import type { NativeStackNavigationOptions } from "expo-router";
import { useNavigation } from "expo-router";
import type { SFSymbol } from "expo-symbols";
import type { ComponentType } from "react";
import { useLayoutEffect, useRef } from "react";
import { NativeActionButton } from "../../components/native/native-action-button";
import { mobileTokens } from "../appearance/appearance";
import { iosAtLeast } from "../native/native-controls";

export type ScreenHeaderAction = {
  kind?: never;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** A save in flight: the button shows disabled until it ends. */
  busy?: boolean;
  /** Primary unless named, as a header Save is. */
  prominence?: "primary" | "secondary" | "destructive";
};

export type ScreenHeaderMenuProps = {
  label: string;
  items: readonly { id: string; label: string }[];
  onSelect: (id: string) => void;
};

type ScreenHeaderMenu = ScreenHeaderMenuProps & {
  kind: "menu";
  symbol: SFSymbol;
  Fallback: ComponentType<ScreenHeaderMenuProps>;
};

/**
 * A screen's title and its one trailing header action. A menu uses native bar items on iOS 26
 * and its supplied trigger elsewhere. The header is set again only when it would look
 * different, and a press always runs the handler of the latest render.
 *
 * A `title` left out keeps the one the layout gave the route. An `action` left out leaves the
 * trailing side alone, and `null` clears it. A button this hook put there never outlives its
 * action: it is cleared when the action stops being given, too.
 */
export function useScreenHeader({
  title,
  action,
}: {
  title?: string;
  action?: ScreenHeaderAction | ScreenHeaderMenu | null;
}) {
  const navigation = useNavigation();
  const latest = useRef(action);
  const installed = useRef(false);
  useLayoutEffect(() => {
    latest.current = action;
  });

  const trailing = action === undefined ? "untouched" : action ? "shown" : "cleared";
  const label = action?.label ?? "";
  const menu = action?.kind === "menu" ? action : undefined;
  const button = action?.kind === "menu" ? undefined : action;
  const inactive = Boolean(button?.disabled || button?.busy);
  const prominence = button?.prominence ?? "primary";
  const menuLayout = menu && JSON.stringify([menu.symbol, menu.items]);
  const Fallback = menu?.Fallback;

  useLayoutEffect(() => {
    const clears = trailing === "cleared" || (trailing === "untouched" && installed.current);
    if (title === undefined && trailing === "untouched" && !clears) return;
    const options: NativeStackNavigationOptions = title === undefined ? {} : { title };
    const press = () => {
      const now = latest.current;
      if (now && now.kind !== "menu" && !now.disabled && !now.busy) now.onPress();
    };
    installed.current = trailing === "shown";
    if (clears) {
      if (iosAtLeast(26)) options.unstable_headerRightItems = undefined;
      else options.headerRight = undefined;
    } else if (menuLayout !== undefined && Fallback) {
      const menu = latest.current;
      if (menu?.kind === "menu") {
        Object.assign(
          options,
          headerMenuOptions(menu, (id) => {
            const now = latest.current;
            if (now?.kind === "menu") now.onSelect(id);
          }),
        );
      }
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
  }, [navigation, title, trailing, label, inactive, prominence, menuLayout, Fallback]);
}

function headerMenuOptions(
  { label, items, symbol, Fallback }: ScreenHeaderMenu,
  onSelect: ScreenHeaderMenuProps["onSelect"],
): NativeStackNavigationOptions {
  if (!iosAtLeast(26)) {
    return { headerRight: () => <Fallback label={label} items={items} onSelect={onSelect} /> };
  }
  return {
    unstable_headerRightItems: () => [
      {
        type: "menu",
        label,
        accessibilityLabel: label,
        icon: { type: "sfSymbol", name: symbol },
        menu: {
          items: items.map(({ id, label }) => ({
            type: "action",
            label,
            onPress: () => onSelect(id),
          })),
        },
      },
    ],
  };
}
