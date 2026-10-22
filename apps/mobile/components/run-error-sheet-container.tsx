import type { ReactElement, ReactNode } from "react";
import { cloneElement, isValidElement } from "react";
import type { ViewProps } from "react-native";
import { Modal, View } from "react-native";
import { useMobileTokens } from "../lib/native";
import { NativeSheet, useNativeSheet } from "./native-sheet";

export function RunErrorSheetContainer({
  children,
  onClose,
  expanded,
  label,
}: {
  children: ReactNode;
  onClose: () => void;
  expanded: boolean;
  label?: string;
}) {
  const tokens = useMobileTokens();
  const Sheet = useNativeSheet();
  if (Sheet === undefined) return null;
  if (Sheet) {
    return (
      <NativeSheet Sheet={Sheet} onClose={onClose} expanded={expanded} label={label}>
        {isValidElement(children)
          ? cloneElement(children as ReactElement<ViewProps>, {
              style: [
                (children as ReactElement<ViewProps>).props.style,
                { flex: undefined, paddingTop: 0, backgroundColor: tokens.card },
              ],
            })
          : children}
      </NativeSheet>
    );
  }
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: tokens.background }}>{children}</View>
    </Modal>
  );
}
