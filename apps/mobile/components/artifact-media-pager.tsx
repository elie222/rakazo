import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { ListViewToken } from "react-native";
import { FlatList, StyleSheet, View } from "react-native";
import type { ArtifactGalleryItem } from "../lib/artifact-gallery";
import { galleryIndex } from "../lib/artifact-gallery";

/** Wait this long after the last visible page changes before loading it. */
const SETTLE_MS = 120;

/**
 * A horizontal, one-artifact-per-page reader. The parent owns the content for each page; this
 * component only decides which page is showing, so a video player is never mounted for a page
 * the person is not looking at.
 */
export function ArtifactMediaPager({
  gallery,
  activeId,
  onActiveIdChange,
  renderPage,
}: {
  gallery: readonly ArtifactGalleryItem[];
  activeId: string;
  onActiveIdChange: (id: string) => void;
  renderPage: (item: ArtifactGalleryItem, active: boolean) => ReactNode;
}) {
  const listRef = useRef<FlatList<ArtifactGalleryItem>>(null);
  const [width, setWidth] = useState(0);
  const initialIndex = Math.max(0, Math.min(gallery.length - 1, galleryIndex(gallery, activeId)));
  const latest = useRef({ gallery, activeId, onActiveIdChange });
  latest.current = { gallery, activeId, onActiveIdChange };
  const dragging = useRef(false);
  const momentum = useRef(false);
  const committedActiveId = useRef(activeId);
  // initialScrollIndex can report the first page before it jumps to the opened artifact.
  const ignoreFirstReport = useRef(true);
  const pendingIndex = useRef<number | null>(null);
  const [settleKey, setSettleKey] = useState(0);
  const previousWidth = useRef(0);

  // Load the page the reader settles on, not every page a fling passes through.
  useTimeout(
    () => {
      if (dragging.current || momentum.current) return;
      const index = pendingIndex.current;
      pendingIndex.current = null;
      if (index === null) return;
      const item = latest.current.gallery[index];
      if (!item || item.id === latest.current.activeId) return;
      committedActiveId.current = item.id;
      latest.current.onActiveIdChange(item.id);
    },
    pendingIndex.current === null ? null : SETTLE_MS,
    settleKey,
  );

  // A route change moves the active artifact without a swipe, so move the mounted list to it.
  useEffect(() => {
    if (width <= 0 || activeId === committedActiveId.current) return;
    committedActiveId.current = activeId;
    pendingIndex.current = null;
    const index = Math.max(0, Math.min(gallery.length - 1, galleryIndex(gallery, activeId)));
    listRef.current?.scrollToOffset({ offset: width * index, animated: false });
  }, [activeId, gallery, width]);

  // Keep the open artifact under the finger when the window rotates.
  useEffect(() => {
    if (width <= 0) return;
    if (previousWidth.current > 0 && previousWidth.current !== width) {
      const index = Math.max(0, Math.min(gallery.length - 1, galleryIndex(gallery, activeId)));
      listRef.current?.scrollToOffset({ offset: width * index, animated: false });
    }
    previousWidth.current = width;
  }, [activeId, gallery, width]);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;
  // FlatList requires this callback to keep its identity; read the latest page through a ref.
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    const index = viewableItems.find((entry) => entry.isViewable)?.index;
    if (index === null || index === undefined) return;
    if (ignoreFirstReport.current) {
      ignoreFirstReport.current = false;
      return;
    }
    pendingIndex.current = index;
    if (!dragging.current && !momentum.current) setSettleKey((key) => key + 1);
  }).current;

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
          initialScrollIndex={initialIndex}
          onScrollToIndexFailed={({ index }) =>
            listRef.current?.scrollToOffset({ offset: width * index, animated: false })
          }
          extraData={activeId}
          renderItem={({ item }) => (
            <View style={[styles.page, { width }]}>{renderPage(item, item.id === activeId)}</View>
          )}
          viewabilityConfig={viewabilityConfig}
          onViewableItemsChanged={onViewableItemsChanged}
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
