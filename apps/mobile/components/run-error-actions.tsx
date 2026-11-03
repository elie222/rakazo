import { NativeActionButton } from "./native-action-button";

/** The one action that fixes a failed run. */
export function RunErrorAction({ label, onPress }: { label: string; onPress: () => void }) {
  return <NativeActionButton label={label} onPress={onPress} prominence="primary" fill={false} />;
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
