import type { ReactNode } from "react";
import { Modal, View } from "react-native";
import { useMobileTokens } from "../lib/native";

export function RunErrorSheetContainer({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
  expanded: boolean;
}) {
  const tokens = useMobileTokens();
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: tokens.background }}>{children}</View>
    </Modal>
  );
}
