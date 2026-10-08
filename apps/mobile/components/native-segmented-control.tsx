import type { NativeSegmentedControlProps } from "../lib/native-controls";
import { SegmentedPills } from "./segmented-pills";

/** Android segmented control. iOS uses a SwiftUI segmented picker. */
export function NativeSegmentedControl<T extends string>(props: NativeSegmentedControlProps<T>) {
  return <SegmentedPills {...props} />;
}
