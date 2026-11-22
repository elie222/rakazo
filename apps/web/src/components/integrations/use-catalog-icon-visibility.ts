import { useCallback, useState } from "react";

const pendingIcons = new Map<Element, () => void>();
let observer: IntersectionObserver | undefined;

function stopObserving(element: Element) {
  if (!pendingIcons.delete(element)) return;
  observer?.unobserve(element);
  if (pendingIcons.size === 0) {
    observer?.disconnect();
    observer = undefined;
  }
}

/** The viewport observer also clips against the catalog's scroll container. */
export function useCatalogIconVisibility(defer: boolean) {
  const [seen, setSeen] = useState(false);
  const ready = !defer || seen || typeof IntersectionObserver === "undefined";
  const placeholderRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element || ready) return;
      observer ??= new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) pendingIcons.get(entry.target)?.();
        }
      });
      pendingIcons.set(element, () => {
        stopObserving(element);
        setSeen(true);
      });
      observer.observe(element);
      return () => stopObserving(element);
    },
    [ready],
  );
  return { ready, placeholderRef };
}
