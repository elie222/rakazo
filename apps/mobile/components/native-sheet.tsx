import type { BottomSheetProps } from "@expo/ui/community/bottom-sheet";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Keyboard, Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { isComposeViewAvailable } from "../lib/compose-available";
import { useMobileTokens } from "../lib/native";

const sheetViews = ["HostView", "ModalBottomSheetView", "RNHostView", "SlotView"];

// Loading constructs native adapters, so even preloading must follow the view checks.
let loadedSheet: ComponentType<BottomSheetProps> | null | undefined;
const sheetLoad =
  Platform.OS === "android" && sheetViews.every(isComposeViewAvailable)
    ? import("@expo/ui/community/bottom-sheet").then(
        ({ BottomSheet }) => {
          loadedSheet = BottomSheet;
        },
        () => {
          loadedSheet = null;
        },
      )
    : undefined;
if (!sheetLoad) loadedSheet = null;

export function useNativeSheet() {
  const [Sheet, setSheet] = useState(() => loadedSheet);
  useEffect(() => {
    let active = true;
    void sheetLoad?.then(() => {
      if (active) setSheet(() => loadedSheet);
    });
    return () => {
      active = false;
    };
  }, []);
  return Sheet;
}

export function NativeSheet({
  Sheet,
  children,
  onClose,
  expanded = false,
  label,
}: {
  Sheet: ComponentType<BottomSheetProps>;
  children: ReactNode;
  onClose: () => void;
  expanded?: boolean;
  label?: string;
}) {
  const tokens = useMobileTokens();
  const { height } = useWindowDimensions();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const closed = useRef(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (event) =>
      setKeyboardHeight(event.endCoordinates.height),
    );
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  // Reserve the native drag handle and cap hosted content above the IME.
  const maxHeight = Math.max(0, height * 0.9 - keyboardHeight - 48);
  return (
    <Sheet
      enableDynamicSizing
      enablePanDownToClose
      backgroundStyle={{ backgroundColor: tokens.card }}
      handleComponent={null}
      onClose={() => {
        if (closed.current) return;
        closed.current = true;
        onClose();
      }}
    >
      {/* The community adapter only supports hiding its stock handle. */}
      <View accessible={false} style={{ alignItems: "center", paddingTop: 16, paddingBottom: 10 }}>
        <View
          style={{
            width: 32,
            height: 4,
            borderRadius: 2,
            backgroundColor: tokens.mutedForeground,
            opacity: 0.4,
          }}
        />
      </View>
      <View
        accessibilityViewIsModal
        accessibilityLabel={label}
        style={{ maxHeight, height: expanded ? maxHeight : undefined }}
      >
        <ScrollView style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
          {children}
        </ScrollView>
      </View>
    </Sheet>
  );
}
