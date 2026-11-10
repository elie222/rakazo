import { lazy, Suspense } from "react";
import { isMessageActionSheetAvailable } from "../lib/message-action-sheet";

// Load only after checking the binary: importing Compose creates native adapters.
const AndroidMessageActionSheetHost = lazy(() => import("./message-action-sheet-compose"));

export function MessageActionSheetHost() {
  if (!isMessageActionSheetAvailable()) return null;
  return (
    <Suspense fallback={null}>
      <AndroidMessageActionSheetHost />
    </Suspense>
  );
}
