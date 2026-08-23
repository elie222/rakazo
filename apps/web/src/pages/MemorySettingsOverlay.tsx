import type { WorkspaceMemoryConfig } from "@rakazo/contracts";
import { memoryProviderSettings } from "./memory-provider-settings";

/** Provider-neutral settings entry point; provider-specific forms stay in their adapters. */
export function MemorySettingsOverlay(props: {
  onClose: () => void;
  config: WorkspaceMemoryConfig | null;
  onConfigChange: (config: WorkspaceMemoryConfig | null) => void;
}) {
  const adapter = memoryProviderSettings(props.config?.provider);
  if (!adapter) return null;
  return <adapter.Settings {...props} />;
}
