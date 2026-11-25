import { useLingui } from "@lingui/react/macro";
import type { ComputerElement } from "@rakazo/contracts";
import { useState } from "react";
import { Alert } from "react-native";
import { useSave } from "../query/query";

/**
 * The middle of the default 1280×800 desktop, so Zoom shows a readable still without the
 * caller having to know the frame's dimensions.
 */
const ZOOM_REGION = { x: 320, y: 200, w: 640, h: 400 };

/**
 * Find on screen, the still Zoom shows, and the click that chooses a found control. Each save
 * reports its own pending and failure state, so the screen only renders what this returns.
 */
export function useComputerFinder(botId: string | undefined) {
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
        payload: { x: element.point.x, y: element.point.y, type: "click" },
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
      find.reset();
    },
    runFind() {
      const text = query.trim();
      if (!botId || !text || find.pending) return;
      find.run(text);
    },
    chooseTarget(element: ComputerElement) {
      if (!click.pending) click.run(element);
    },
    runZoom() {
      if (!botId || zoom.pending) return;
      zoom.run(ZOOM_REGION);
    },
    closeZoom() {
      setZoomImage(null);
    },
  };
}
