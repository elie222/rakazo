import { useNavigation, useRouter } from "expo-router";
import { useLayoutEffect } from "react";
import { useI18n } from "./i18n";

/** Liquid Glass home header: account on the left; activity, search and create on the right. */
export function useHomeHeader({
  nativeHeader,
  ready,
  hasSession,
  initials,
  activityMode,
  toggleActivityMode,
  runCreateAction,
}: {
  nativeHeader: boolean;
  ready: boolean;
  hasSession: boolean;
  initials: string;
  activityMode: boolean;
  toggleActivityMode: () => void;
  runCreateAction: (action: "bot" | "group" | "space") => void;
}) {
  const navigation = useNavigation();
  const router = useRouter();
  const { t, locale } = useI18n();
  useLayoutEffect(() => {
    if (!nativeHeader) return;
    const signedIn = ready && hasSession;
    navigation.setOptions({
      headerShown: signedIn,
      headerTransparent: true,
      headerStyle: { backgroundColor: "transparent" },
      title: "",
      unstable_headerLeftItems: () => [
        {
          type: "button" as const,
          label: t("Account"),
          icon: { type: "sfSymbol" as const, name: "person.crop.circle" },
          accessibilityLabel: t("Account"),
          onPress: () => router.push("/account"),
        },
      ],
      unstable_headerRightItems: () => [
        {
          type: "button" as const,
          label: t("Activity"),
          accessibilityLabel: t("Activity"),
          icon: { type: "sfSymbol" as const, name: activityMode ? "bell.fill" : "bell" },
          selected: activityMode,
          onPress: toggleActivityMode,
        },
        {
          type: "button" as const,
          label: t("Search"),
          accessibilityLabel: t("Search"),
          identifier: "home-search-button",
          icon: { type: "sfSymbol" as const, name: "magnifyingglass" },
          onPress: () => router.push("/search"),
        },
        {
          type: "menu" as const,
          label: t("Create"),
          accessibilityLabel: t("Create"),
          icon: { type: "sfSymbol" as const, name: "plus" },
          menu: {
            items: [
              {
                type: "action" as const,
                label: t("New bot"),
                icon: { type: "sfSymbol" as const, name: "person.crop.circle.badge.plus" },
                onPress: () => runCreateAction("bot"),
              },
              {
                type: "action" as const,
                label: t("New group chat"),
                icon: { type: "sfSymbol" as const, name: "person.2" },
                onPress: () => runCreateAction("group"),
              },
              {
                type: "action" as const,
                label: t("New private space"),
                icon: { type: "sfSymbol" as const, name: "square.grid.2x2" },
                onPress: () => runCreateAction("space"),
              },
            ],
          },
        },
      ],
    });
  }, [
    nativeHeader,
    navigation,
    ready,
    hasSession,
    initials,
    activityMode,
    toggleActivityMode,
    runCreateAction,
    router,
    t,
    locale,
  ]);
}
