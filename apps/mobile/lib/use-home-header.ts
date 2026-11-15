import { useLingui } from "@lingui/react/macro";
import { useNavigation, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useLayoutEffect } from "react";
import type { CreateAction } from "./create-chooser";
import { createMenuItems } from "./create-chooser";
import { useUiLocale } from "./i18n";

/** Liquid Glass home header: account on the left, create on the right. Activity and search sit in the bottom bar. */
export function useHomeHeader({
  nativeHeader,
  ready,
  hasSession,
  initials,
  runCreateAction,
  headerTitle,
}: {
  nativeHeader: boolean;
  ready: boolean;
  hasSession: boolean;
  initials: string;
  runCreateAction: (action: CreateAction) => void;
  headerTitle?: () => ReactNode;
}) {
  const navigation = useNavigation();
  const router = useRouter();
  const { t, i18n } = useLingui();
  const locale = useUiLocale();
  useLayoutEffect(() => {
    if (!nativeHeader) return;
    const signedIn = ready && hasSession;
    navigation.setOptions({
      headerShown: signedIn,
      headerTransparent: true,
      headerStyle: { backgroundColor: "transparent" },
      title: "",
      headerTitle,
      unstable_headerLeftItems: () => [
        {
          type: "button" as const,
          label: t`Account`,
          icon: { type: "sfSymbol" as const, name: "person.crop.circle" },
          accessibilityLabel: t`Account`,
          onPress: () => router.push("/account"),
        },
      ],
      unstable_headerRightItems: () => [
        {
          type: "menu" as const,
          label: t`Create`,
          accessibilityLabel: t`Create`,
          icon: { type: "sfSymbol" as const, name: "plus" },
          menu: {
            items: createMenuItems.map(({ id, label, sfSymbol }) => ({
              type: "action" as const,
              label: i18n._(label),
              icon: { type: "sfSymbol" as const, name: sfSymbol },
              onPress: () => runCreateAction(id),
            })),
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
    runCreateAction,
    headerTitle,
    router,
    t,
    locale,
  ]);
}
