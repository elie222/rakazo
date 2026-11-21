import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";
import { ScrollView, StyleSheet } from "react-native";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import { routineRowDetail, routineRowLabel } from "../../lib/routines/routine";
import { NativeSwitch } from "../native/native-switch";
import { SettingsGroup, SettingsRow, useStackedSettings } from "../settings/settings-group";

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
  const { t } = useLingui();
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
          const deleteLabel = t`Delete ${ph({ name: routine.name })}`;
          const switchLabel = t`Active: ${ph({ name: routine.name })}`;
          return (
            <SettingsRow
              key={routine.id}
              accessibilityRole="button"
              accessibilityLabel={routineRowLabel(routine)}
              // The row is one element for screen readers, so its switch and delete are actions.
              accessibilityActions={[
                { name: "toggle", label: switchLabel },
                ...(canDelete ? [{ name: "delete", label: deleteLabel }] : []),
              ]}
              onAccessibilityAction={({ nativeEvent }) =>
                nativeEvent.actionName === "delete"
                  ? onDelete(routine)
                  : onToggle(routine, !routine.active)
              }
              title={routine.name}
              detail={routineRowDetail(routine, timeZone)}
              onPress={() => onOpen(routine)}
              onLongPress={canDelete ? () => onDelete(routine) : undefined}
              trailing={
                <NativeSwitch
                  accessibilityLabel={switchLabel}
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
