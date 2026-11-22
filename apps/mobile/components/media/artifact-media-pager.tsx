import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import type { ArtifactGalleryItem } from "../../lib/artifacts/artifact-gallery";
import { galleryIndex } from "../../lib/artifacts/artifact-gallery";

const SETTLE_MS = 120;

export function ArtifactMediaPager({
  gallery,
  activeId,
  onActiveIdChange,
  children,
}: {
  gallery: readonly ArtifactGalleryItem[];
  activeId: string;
  onActiveIdChange: (id: string) => void;
  children: ReactNode;
}) {
  const listRef = useRef<FlatList<ArtifactGalleryItem>>(null);
  const [width, setWidth] = useState(0);
  const activeIndex = galleryIndex(gallery, activeId);
  const dragging = useRef(false);
  const momentum = useRef(false);
  // initialScrollIndex can report the first page before it jumps to the opened artifact.
  const ignoreFirstReport = useRef(true);
  const pendingIndex = useRef<number | null>(null);
  const [settleKey, setSettleKey] = useState(0);
  const previousWidth = useRef(0);

  useTimeout(
    () => {
      if (dragging.current || momentum.current) return;
      const index = pendingIndex.current;
      pendingIndex.current = null;
      if (index === null) return;
      const item = gallery[index];
      if (item && item.id !== activeId) onActiveIdChange(item.id);
    },
    pendingIndex.current === null ? null : SETTLE_MS,
    settleKey,
  );

  useEffect(() => {
    if (width === previousWidth.current) return;
    if (previousWidth.current > 0) {
      pendingIndex.current = null;
      listRef.current?.scrollToOffset({ offset: width * activeIndex, animated: false });
    }
    previousWidth.current = width;
  }, [activeIndex, width]);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  return (
    <View
      style={styles.container}
      onLayout={(event) => {
        const next = event.nativeEvent.layout.width;
        if (next > 0 && next !== width) setWidth(next);
      }}
    >
      {width > 0 ? (
        <FlatList
          ref={listRef}
          data={gallery}
          horizontal
          pagingEnabled
          bounces={false}
          showsHorizontalScrollIndicator={false}
          keyExtractor={(item) => item.id}
          getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
          initialScrollIndex={activeIndex}
          onScrollToIndexFailed={({ index }) =>
            listRef.current?.scrollToOffset({ offset: width * index, animated: false })
          }
          extraData={activeId}
          renderItem={({ item }) => (
            <View style={[styles.page, { width }]}>{item.id === activeId ? children : null}</View>
          )}
          viewabilityConfig={viewabilityConfig}
          onViewableItemsChanged={({ viewableItems }) => {
            const index = viewableItems.find((entry) => entry.isViewable)?.index;
            if (index == null) return;
            if (ignoreFirstReport.current) {
              ignoreFirstReport.current = false;
              return;
            }
            pendingIndex.current = index;
            if (!dragging.current && !momentum.current) setSettleKey((key) => key + 1);
          }}
          onScrollBeginDrag={() => {
            momentum.current = false;
            dragging.current = true;
          }}
          onScrollEndDrag={() => {
            dragging.current = false;
            setSettleKey((key) => key + 1);
          }}
          onMomentumScrollBegin={() => {
            momentum.current = true;
          }}
          onMomentumScrollEnd={() => {
            momentum.current = false;
            setSettleKey((key) => key + 1);
          }}
          windowSize={3}
          initialNumToRender={2}
          maxToRenderPerBatch={2}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  page: { flex: 1 },
});
