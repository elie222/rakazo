import { BottomSheet } from "@expo/ui/community/bottom-sheet";
import type { ReactNode } from "react";
import { useMobileTokens } from "../../lib/native/native";

export function RunErrorSheetContainer({
  children,
  onClose,
  expanded,
}: {
  children: ReactNode;
  onClose: () => void;
  expanded: boolean;
}) {
  const tokens = useMobileTokens();
  return (
    <BottomSheet
      snapPoints={expanded ? ["90%"] : undefined}
      enableDynamicSizing
      enablePanDownToClose
      onClose={onClose}
      backgroundStyle={{ backgroundColor: tokens.background }}
    >
      {children}
    </BottomSheet>
  );
}
