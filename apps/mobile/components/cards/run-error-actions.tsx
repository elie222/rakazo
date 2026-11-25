import { useWindowDimensions } from "react-native";
import { NativeActionButton } from "../native/native-action-button";

/** The one action that fixes a failed run; it fills its row once large text would crowd it. */
export function RunErrorAction({
  label,
  onPress,
  busy,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
}) {
  const { fontScale } = useWindowDimensions();
  return (
    <NativeActionButton
      label={label}
      onPress={onPress}
      prominence="primary"
      fill={fontScale > 1.3}
      busy={busy}
    />
  );
}

export function RunErrorTextAction({
  label,
  onPress,
  expanded,
}: {
  label: string;
  onPress: () => void;
  expanded?: boolean;
}) {
  return (
    <NativeActionButton
      variant="text"
      label={label}
      onPress={onPress}
      fill={false}
      icon={
        expanded === undefined
          ? undefined
          : {
              ios: expanded ? "chevron.down" : "chevron.right",
              android: expanded ? "chevron-down" : "chevron-forward",
            }
      }
    />
  );
}
