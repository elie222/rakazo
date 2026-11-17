import { useLocalSearchParams } from "expo-router";
import { ScrollView } from "react-native";
import { RoutineRunHistory } from "../components/routine-run-history";
import { native } from "../lib/native";
import { useSideInsets } from "../lib/side-insets";

/** A routine's past runs, opened from its detail. */
export default function RoutineRuns() {
  const sideInsets = useSideInsets();
  const { routineId = "", botName } = useLocalSearchParams<{
    routineId?: string;
    botName?: string;
  }>();
  return (
    <ScrollView
      style={[{ flex: 1, backgroundColor: native.groupedPage }, sideInsets]}
      contentContainerStyle={{ padding: 24, gap: 18 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <RoutineRunHistory routineId={routineId} botName={botName} />
    </ScrollView>
  );
}
