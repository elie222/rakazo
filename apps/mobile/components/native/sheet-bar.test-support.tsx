import type { ReactNode } from "react";
import { createElement, Fragment } from "react";

type Action = { label: string; onPress: () => void; disabled?: boolean };

const action = ({ label, onPress, disabled }: Action) =>
  createElement("button", { type: "button", onClick: onPress, disabled }, label);

/** The sheet bar as plain buttons named by their labels, for tests that mock native views. */
export function SheetBar({ leading, trailing }: { leading?: ReactNode; trailing?: ReactNode }) {
  return createElement(Fragment, null, leading, trailing);
}
export const SheetBarClose = action;
export const SheetBarBack = action;
export const SheetBarConfirm = action;
