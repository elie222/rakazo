import type { ButtonProps } from "@expo/ui/swift-ui";
import type { ReactNode } from "react";

/** A row's long-press menu; titles are already translated. */
export type NativeRowMenu = {
  actions: Array<{
    id: string;
    title: string;
    image?: ButtonProps["systemImage"];
    destructive?: boolean;
    disabled?: boolean;
  }>;
  onAction: (id: string) => void;
};

/** Native list rows are iOS only; elsewhere a row is its content. */
export function NativeRow({ children }: { menu?: NativeRowMenu; children: ReactNode }) {
  return <>{children}</>;
}

export function NativeRowContent({ children }: { width?: number; children: ReactNode }) {
  return <>{children}</>;
}
