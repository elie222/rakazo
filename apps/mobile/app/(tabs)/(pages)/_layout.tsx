import { useLingui } from "@lingui/react/macro";
import { Stack } from "expo-router";
import { glassHeaderOptions } from "../../../components/native/glass-title";
import { TabStack } from "../../../components/screens/tab-stack";

export default function PagesLayout() {
  const { t } = useLingui();
  return (
    <TabStack>
      <Stack.Screen name="pages" options={glassHeaderOptions(t`Pages`)} />
    </TabStack>
  );
}
