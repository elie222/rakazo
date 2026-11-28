import { useLingui } from "@lingui/react/macro";
import { Stack } from "expo-router";
import { TabStack } from "../../../components/screens/tab-stack";

export default function ActivityLayout() {
  const { t } = useLingui();
  return (
    <TabStack>
      <Stack.Screen name="activity" options={{ headerShown: false, title: t`Activity` }} />
    </TabStack>
  );
}
