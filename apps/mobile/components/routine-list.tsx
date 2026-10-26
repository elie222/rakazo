import type { Routine } from "@rakazo/contracts";
import { ScrollView, StyleSheet } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { routineRowDetail, routineRowLabel } from "../lib/routine";
import { useSideInsets } from "../lib/side-insets";
import { NativeSwitch } from "./native-switch";
import { SettingsGroup, SettingsRow, useStackedSettings } from "./settings-group";

export type RoutineListProps = {
  routines: Routine[];
  timeZone: string | undefined;
  /** False while a delete is in flight. */
  canDelete: boolean;
  onOpen: (routine: Routine) => void;
  onToggle: (routine: Routine, active: boolean) => void;
  onDelete: (routine: Routine) => void;
};

/** Settings-style rows; iOS adds the system swipe to delete. Here a long press deletes. */
export function RoutineList({
  routines,
  timeZone,
  canDelete,
  onOpen,
  onToggle,
  onDelete,
}: RoutineListProps) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const stacked = useStackedSettings();
  const sideInsets = useSideInsets();
  return (
    <ScrollView
      style={[styles.screen, sideInsets]}
      contentContainerStyle={[styles.content, stacked && styles.compactContent]}
      contentInsetAdjustmentBehavior="automatic"
    >
      <SettingsGroup>
        {routines.map((routine) => {
          const deletable = canDelete && routine.editable !== false;
          const deleteLabel = t("Delete {name}", { name: routine.name });
          const switchLabel = t("Active: {name}", { name: routine.name });
          return (
            <SettingsRow
              key={routine.id}
              accessibilityRole="button"
              accessibilityLabel={routineRowLabel(routine)}
              // The row is one element for screen readers, so its switch and delete are actions.
              accessibilityActions={[
                ...(routine.editable === false ? [] : [{ name: "toggle", label: switchLabel }]),
                ...(deletable ? [{ name: "delete", label: deleteLabel }] : []),
              ]}
              onAccessibilityAction={({ nativeEvent }) =>
                nativeEvent.actionName === "delete"
                  ? onDelete(routine)
                  : onToggle(routine, !routine.active)
              }
              title={routine.name}
              detail={routineRowDetail(routine, timeZone)}
              onPress={() => onOpen(routine)}
              onLongPress={deletable ? () => onDelete(routine) : undefined}
              trailing={
                <NativeSwitch
                  accessibilityLabel={switchLabel}
                  disabled={routine.editable === false}
                  value={routine.active}
                  onValueChange={(active) => onToggle(routine, active)}
                />
              }
            />
          );
        })}
      </SettingsGroup>
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 },
    compactContent: { paddingHorizontal: 8 },
  });
}
