import { useLingui } from "@lingui/react/macro";
import { Stack } from "expo-router";
import { glassHeaderOptions } from "../../../components/native/glass-title";
import { TabStack } from "../../../components/screens/tab-stack";

export default function RoutinesLayout() {
  const { t } = useLingui();
  return (
    <TabStack>
      <Stack.Screen name="routines" options={glassHeaderOptions(t`Routines`)} />
    </TabStack>
  );
}
