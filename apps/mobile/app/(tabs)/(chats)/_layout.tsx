import { Stack } from "expo-router";
import { TabStack } from "../../../components/screens/tab-stack";

export default function ChatsLayout() {
  return (
    <TabStack>
      <Stack.Screen name="index" options={{ headerShown: false, title: "Rakazo" }} />
    </TabStack>
  );
}
