import type { Space } from "@rakazo/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { SetURLSearchParams } from "react-router-dom";
import { desktopBridge } from "../../lib/platform/desktop";
import type { ImportSetupTarget } from "./bots/import-setup-card";
import type { SettingsSection, ShellOverlay } from "./shell-overlay-url";

/** Opening settings, the space they edit, and routing an import's setup checklist to its fix. */
export function useShellSettings({
  overlay,
  setOverlay,
  searchParams,
  setSearchParams,
  spaces,
  currentSpaceId,
  initialBotsLoaded,
  refreshActiveThread,
}: {
  overlay: ShellOverlay;
  setOverlay: (overlay: ShellOverlay) => void;
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
  spaces: Space[];
  currentSpaceId: string | null;
  initialBotsLoaded: boolean;
  refreshActiveThread: () => Promise<unknown>;
}) {
  // null: settings follow the space the app is showing.
  const settingsSpaceId = overlay?.kind === "settings" ? overlay.spaceId : null;
  const settingsSpace =
    spaces.find((space) => space.id === (settingsSpaceId ?? currentSpaceId)) ?? null;
  // Never fall back to another space's settings when the edited space goes away.
  const settingsSpaceGone = initialBotsLoaded && settingsSpaceId !== null && !settingsSpace;
  useEffect(() => {
    if (settingsSpaceGone) setOverlay(null);
  }, [settingsSpaceGone]);

  function openSettings(section: SettingsSection = "general", spaceId: string | null = null) {
    setOverlay({ kind: "settings", section, spaceId });
  }
  // Space-scoped sections bind their own rpc client to this space, so another
  // space's settings open in place without switching the app or reloading.
  function openSpaceSettings(spaceId: string) {
    openSettings("space", spaceId);
  }
  // The app menu owns Cmd+, because macOS takes it before the page sees a keydown.
  const openSettingsRef = useRef(openSettings);
  openSettingsRef.current = openSettings;
  useEffect(() => desktopBridge()?.settings?.onOpen(() => openSettingsRef.current("general")), []);

  // An import's setup checklist re-checks on each thread refresh, so refresh once setup closes.
  const importSetupOpen = useRef(false);
  useEffect(() => {
    if (!importSetupOpen.current || overlay || searchParams.has("routine")) return;
    importSetupOpen.current = false;
    void refreshActiveThread();
  }, [overlay, searchParams, refreshActiveThread]);
  const setOverlayRef = useRef(setOverlay);
  useLayoutEffect(() => {
    setOverlayRef.current = setOverlay;
  }, [setOverlay]);
  const openAgentImport = useCallback(() => setOverlayRef.current({ kind: "import" }), []);
  const openImportSetup = useCallback(
    (target: ImportSetupTarget) => {
      importSetupOpen.current = true;
      if (target.kind === "models")
        setOverlayRef.current({ kind: "settings", section: "models", spaceId: null });
      else if (target.kind === "mcp")
        setOverlayRef.current({ kind: "mcp", serverId: target.serverId });
      else {
        setSearchParams((current) => {
          const next = new URLSearchParams(current);
          next.set("routine", target.routineId);
          return next;
        });
      }
    },
    [setSearchParams],
  );

  return {
    settingsSpaceId,
    settingsSpace,
    openSettings,
    openSpaceSettings,
    openImportSetup,
    openAgentImport,
  };
}
