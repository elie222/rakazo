import { hapticImpact, hapticSelection } from "./haptics";

export function actionPressHandler(inactive: boolean, onPress: () => void) {
  if (inactive) return undefined;
  return () => {
    hapticImpact();
    onPress();
  };
}

export function selectionChangeHandler<T extends string>(
  value: T | undefined,
  disabled: boolean | undefined,
  onChange: (value: T) => void,
) {
  return (next: T) => {
    if (disabled || next === value) return;
    hapticSelection();
    onChange(next);
  };
}
