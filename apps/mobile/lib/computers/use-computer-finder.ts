import { useLingui } from "@lingui/react/macro";
import type { ComputerElement } from "@rakazo/contracts";
import { useState } from "react";
import { Alert } from "react-native";
import { useSave } from "../query/query";

/** The middle half of the computer's own screen, whatever its size. */
function zoomRegion(screen: { width: number; height: number } | undefined) {
  const width = screen?.width ?? 1280;
  const height = screen?.height ?? 800;
  const w = Math.round(width / 2);
  const h = Math.round(height / 2);
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
}

/**
 * Find on screen, the still Zoom shows, and the click that chooses a found control. Each save
 * reports its own pending and failure state, so the screen only renders what this returns.
 *
 * `hasControl` gates the click: without the lease the input RPC is refused, so a result must not
 * look selectable. `screen` sizes the zoom crop to the computer rather than to a default desktop.
 */
export function useComputerFinder(
  botId: string | undefined,
  options: { hasControl: boolean; screen?: { width: number; height: number } } = {
    hasControl: true,
  },
) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ComputerElement[]>([]);
  const [zoomImage, setZoomImage] = useState<string | null>(null);

  const find = useSave({
    save: async (text: string, send) => {
      const result = await send("computer/find", { botId: botId ?? "", text, limit: 30 });
      // The screen never answered, so an empty list would read as "no match" instead of a failure.
      if (result.unknown) throw new Error(t`The screen did not answer in time.`);
      return result;
    },
    onSaved: (result) => setResults(result.elements),
  });
  const zoom = useSave({
    save: (region: { x: number; y: number; w: number; h: number }, send) =>
      send("computer/zoom", { botId: botId ?? "", region }),
    onSaved: (result) => setZoomImage(result.image),
    onFailed: (error) => Alert.alert(t`Could not zoom into the screen.`, error.message),
  });
  const click = useSave({
    save: (element: ComputerElement, send) =>
      send("computer/input", {
        botId: botId ?? "",
        kind: "pointer",
        // The server re-resolves the control, so a screen that changed under the viewer is
        // not clicked at its old point.
        payload: { x: element.point.x, y: element.point.y, type: "click", target: element },
      }),
    onSaved: () => {
      setOpen(false);
      setResults([]);
      setQuery("");
    },
    onFailed: (error) => Alert.alert(t`Could not click that control.`, error.message),
  });

  return {
    open,
    query,
    results,
    zoomImage,
    find,
    zoom,
    click,
    openFinder() {
      find.reset();
      setOpen(true);
    },
    closeFinder() {
      setOpen(false);
    },
    changeQuery(text: string) {
      setQuery(text);
      setResults([]);
      find.reset();
    },
    runFind() {
      const text = query.trim();
      if (!botId || !text || find.pending) return;
      find.run(text);
    },
    chooseTarget(element: ComputerElement) {
      if (options.hasControl && !click.pending) click.run(element);
    },
    runZoom() {
      if (!botId || zoom.pending) return;
      zoom.run(zoomRegion(options.screen));
    },
    closeZoom() {
      setZoomImage(null);
    },
  };
}
