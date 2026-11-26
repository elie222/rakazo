import type { ComputerCapabilities } from "@rakazo/contracts";

export const DEFAULT_DISPLAY = { width: 1280, height: 800, scale: 1 } as const;

/** A conservative report for a provider that cannot inspect its computer. */
export function unavailableCapabilities(
  display: { width: number; height: number; scale: number } = DEFAULT_DISPLAY,
): ComputerCapabilities {
  return {
    version: 1,
    search: "service_path",
    programs: {},
    display,
    perception: {
      atspi: false,
      cdp: true,
      hitTest: false,
      settle: true,
      zoom: true,
    },
    stream: { protocol: "vnc", quality: false },
    recording: false,
    desktopApps: false,
  };
}

/** What a provider that implements the full perception stack reports. */
export function supportedCapabilities(
  display: { width: number; height: number; scale: number } = DEFAULT_DISPLAY,
  programs: Record<string, "available" | "not_on_path" | "unknown"> = {},
): ComputerCapabilities {
  return {
    ...unavailableCapabilities(display),
    programs,
    perception: {
      atspi: true,
      cdp: true,
      hitTest: true,
      settle: true,
      zoom: true,
    },
  };
}
