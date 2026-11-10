import { BottomSheet } from "@expo/ui/community/bottom-sheet";
import type { ReactNode } from "react";
import { useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { useMobileTokens } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";

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
  const { width } = useWindowDimensions();
  const [contentHeight, setContentHeight] = useState(0);
  // Floating phone sheets inset the hosted page by 9pt per side. RNHostView retains
  // the presenting surface's coordinates; restore point sizes at this native boundary.
  const scale = iosAtLeast(26) && width < 600 ? width / (width - 18) : 1;
  return (
    <BottomSheet
      snapPoints={expanded ? ["90%"] : undefined}
      enableDynamicSizing
      enablePanDownToClose
      onClose={onClose}
      backgroundStyle={{ backgroundColor: tokens.background }}
    >
      <View style={{ height: contentHeight ? contentHeight * scale : undefined }}>
        <View
          onLayout={({ nativeEvent }) => setContentHeight(nativeEvent.layout.height)}
          style={{
            width: width / scale,
            transform: [{ scale }],
            transformOrigin: "top left",
          }}
        >
          {children}
        </View>
      </View>
    </BottomSheet>
  );
}
