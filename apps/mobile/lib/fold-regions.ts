import { requireOptionalNativeModule } from "expo-modules-core";
import { useEffect, useState } from "react";
import { Platform } from "react-native";

export type FoldRegion = { x: number; y: number; width: number; height: number };
type FoldModule = {
  getRegions(): Promise<FoldRegion[]>;
  addListener(
    event: "onChange",
    listener: (event: { regions: FoldRegion[] }) => void,
  ): { remove(): void };
};

const nativeFold =
  Platform.OS === "ios" ? requireOptionalNativeModule<FoldModule>("RakazoFoldRegions") : null;

/** Optional so an updated bundle also runs on binaries built before fold support. */
export function useFoldRegions(): FoldRegion[] {
  const [regions, setRegions] = useState<FoldRegion[]>([]);
  useEffect(() => {
    if (!nativeFold) return;
    let current = true;
    let changed = false;
    const subscription = nativeFold.addListener("onChange", (event) => {
      changed = true;
      if (current) setRegions(event.regions);
    });
    void nativeFold
      .getRegions()
      .then((initial) => {
        if (current && !changed) setRegions(initial);
      })
      .catch(() => undefined);
    return () => {
      current = false;
      subscription.remove();
    };
  }, []);
  return regions;
}
