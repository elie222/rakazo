import { lazy, Suspense } from "react";
import { Platform } from "react-native";
import { isComposeViewAvailable } from "../lib/compose-available";
import type { NativeSegmentedControlProps } from "../lib/native-controls";
import type ComposeSegmentedControlComponent from "./native-segmented-control-compose";
import { SegmentedPills } from "./segmented-pills";

// Loading the adapters is safe only after checking the running binary's views.
const ComposeSegmentedControl = lazy(
  () => import("./native-segmented-control-compose"),
) as typeof ComposeSegmentedControlComponent;
const requiredViews = [
  "HostView",
  "SingleChoiceSegmentedButtonRowView",
  "SegmentedButtonView",
  "SlotView",
  "TextView",
];

/** Android segmented control. iOS uses a SwiftUI segmented picker. */
export function NativeSegmentedControl<T extends string>(props: NativeSegmentedControlProps<T>) {
  const fallback = <SegmentedPills {...props} />;
  if (
    props.options.length >= 4 ||
    Platform.OS !== "android" ||
    !requiredViews.every(isComposeViewAvailable)
  )
    return fallback;
  return (
    <Suspense fallback={fallback}>
      <ComposeSegmentedControl {...props} />
    </Suspense>
  );
}
