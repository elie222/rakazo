import type { WorkspaceMemoryConfig } from "@rakazo/contracts";
import { SupermemorySettingsOverlay } from "./SupermemorySettingsOverlay";

/** Provider-neutral settings entry point; provider-specific forms stay in their adapters. */
export function MemorySettingsOverlay(props: {
  onClose: () => void;
  config: WorkspaceMemoryConfig | null;
  onConfigChange: (config: WorkspaceMemoryConfig | null) => void;
}) {
  return <SupermemorySettingsOverlay {...props} />;
}
