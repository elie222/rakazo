import { useLingui } from "@lingui/react/macro";
import { Stack, useRouter } from "expo-router";

/** The home screen's bottom toolbar beside the Liquid Glass header: integrations, then account. */
export function InboxToolbar() {
  const { t } = useLingui();
  const router = useRouter();
  return (
    <Stack.Toolbar placement="bottom">
      <Stack.Toolbar.Spacer />
      <Stack.Toolbar.Button
        icon="puzzlepiece.extension"
        accessibilityLabel={t`Integrations`}
        onPress={() => router.push("/integrations")}
      />
      {/* A fixed space gives each button its own glass. */}
      <Stack.Toolbar.Spacer width={8} />
      <Stack.Toolbar.Button
        icon="person.crop.circle"
        accessibilityLabel={t`Account`}
        onPress={() => router.push("/account")}
      />
    </Stack.Toolbar>
  );
}
