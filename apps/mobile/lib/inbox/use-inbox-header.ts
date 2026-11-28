import { useLingui } from "@lingui/react/macro";
import { useNavigation, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useLayoutEffect } from "react";
import { useUiLocale } from "../i18n/i18n";
import type { CreateAction } from "./create-chooser";
import { createMenuItems } from "./create-chooser";

/**
 * Liquid Glass home header: account on the left and create on the right. Chats, Activity, Pages,
 * Routines and Search are tabs in the native tab bar.
 */
export function useInboxHeader({
  nativeHeader,
  ready,
  hasSession,
  runCreateAction,
  headerTitle,
}: {
  nativeHeader: boolean;
  ready: boolean;
  hasSession: boolean;
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
          accessibilityLabel: t`Account`,
          icon: { type: "sfSymbol" as const, name: "person.crop.circle" },
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
    runCreateAction,
    headerTitle,
    router,
    t,
    locale,
  ]);
}
