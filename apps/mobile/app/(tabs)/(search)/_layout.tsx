import { useLingui } from "@lingui/react/macro";
import { Stack } from "expo-router";
import { Platform } from "react-native";
import { TabStack } from "../../../components/screens/tab-stack";
import { iosAtLeast } from "../../../lib/native/native-controls";

export default function SearchLayout() {
  const { t } = useLingui();
  // On iOS 26 the system search field (the screen's header search bar) takes the tab bar's place
  // under a "Search" title; older systems keep the screen's own field and no header.
  const nativeSearch = Platform.OS === "ios" && iosAtLeast(26);
  return (
    <TabStack>
      <Stack.Screen name="search" options={{ headerShown: nativeSearch, title: t`Search` }} />
    </TabStack>
  );
}
