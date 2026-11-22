/**
 * One height per size name for every form control (Button, SelectTrigger, OptionSelect, Input),
 * so controls of the same size placed side by side always line up.
 */
export const controlHeight = {
  xs: "h-6",
  sm: "h-7",
  default: "h-8",
  lg: "h-9",
  xl: "h-12",
} as const;

/** Square controls, such as icon buttons, on the same scale. */
export const controlSquare = {
  xs: "size-6",
  sm: "size-7",
  default: "size-8",
  lg: "size-9",
} as const;

export type ControlSize = keyof typeof controlHeight;

/** The sizes a field (an Input or a select) comes in; a button also has xs. */
export type FieldSize = Exclude<ControlSize, "xs">;
