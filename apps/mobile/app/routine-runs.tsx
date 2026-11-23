import { useLocalSearchParams } from "expo-router";
import { ScrollView } from "react-native";
import { RoutineRunHistory } from "../components/routines/routine-run-history";
import { useSideInsets } from "../lib/layout/side-insets";
import { native } from "../lib/native/native";

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
