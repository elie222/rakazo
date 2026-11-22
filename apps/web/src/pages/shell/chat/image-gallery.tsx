import { useLingui } from "@lingui/react/macro";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ArtifactTarget } from "../../../lib/pages/artifact-open";
import { useArtifactImage } from "../../../lib/pages/use-artifact-image";
import { useEventListener } from "../../../lib/use-event-listener";
import { isEditableTarget } from "../shell-shortcuts";

export type GalleryImage = {
  artifactId: string;
  name: string;
  target: ArtifactTarget;
};

const ImageGalleryContext = createContext<((image: GalleryImage) => void) | null>(null);

/** Opens an image in the chat's gallery; null outside a gallery, so the caller shows it alone. */
export function useOpenImage() {
  return useContext(ImageGalleryContext);
}

export function galleryImageKey(image: GalleryImage) {
  const owner =
    "botId" in image.target ? `bot:${image.target.botId}` : `group:${image.target.groupId}`;
  return `${owner}:${image.artifactId}`;
}

/** Holds the chat's images and the one lightbox they all open in, in message order. */
export function ImageGalleryProvider({
  images,
  children,
}: {
  images: GalleryImage[];
  children: ReactNode;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const open = useCallback((image: GalleryImage) => setSelectedKey(galleryImageKey(image)), []);
  const selectedAt = selectedKey
    ? images.findIndex((image) => galleryImageKey(image) === selectedKey)
    : -1;
  useEffect(() => {
    if (selectedKey && selectedAt === -1) setSelectedKey(null);
  }, [selectedKey, selectedAt]);
  return (
    <ImageGalleryContext.Provider value={open}>
      {children}
      {selectedKey && selectedAt !== -1 ? (
        <ImageLightbox
          images={images}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          onClose={() => setSelectedKey(null)}
        />
      ) : null}
    </ImageGalleryContext.Provider>
  );
}

function GalleryThumb({
  image,
  active,
  onSelect,
  tabIndex,
}: {
  image: GalleryImage;
  active: boolean;
  onSelect: () => void;
  tabIndex?: number;
}) {
  const { t } = useLingui();
  const src = useArtifactImage(image.target, image.artifactId);
  return (
    <button
      type="button"
      aria-label={t`Show ${image.name}`}
      aria-current={active || undefined}
      tabIndex={tabIndex}
      onClick={onSelect}
      className="block h-20 w-28 shrink-0 overflow-hidden rounded-lg bg-muted shadow-lg"
    >
      {src ? (
        <img src={src} alt="" loading="lazy" className="size-full object-cover" />
      ) : (
        <span className="block size-full" />
      )}
    </button>
  );
}

// Keyed by image, so switching never shows the previous picture under the new name.
function LightboxPicture({ image }: { image: GalleryImage }) {
  const src = useArtifactImage(image.target, image.artifactId);
  return src ? (
    <img
      src={src}
      alt={image.name}
      className="max-h-full max-w-[calc(100%-6rem)] cursor-zoom-out rounded-xl object-contain"
    />
  ) : (
    <div className="size-40 rounded-xl bg-muted" />
  );
}

/**
 * The picture at full size over the page, with the chat's other pictures beside it: arrows and
 * the carousel move through them, and the arrow keys, Escape or a click dismiss the lightbox.
 */
export function ImageLightbox({
  images,
  selectedKey,
  onSelect,
  onClose,
}: {
  images: GalleryImage[];
  selectedKey: string;
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const index = images.findIndex((image) => galleryImageKey(image) === selectedKey);
  const current = images[index];
  const close = useRef<HTMLButtonElement>(null);
  const single = images.length < 2;
  const step = (delta: number) => {
    const next = images[(index + delta + images.length) % images.length];
    if (next) onSelect(galleryImageKey(next));
  };

  useEffect(() => {
    close.current?.focus();
  }, []);
  // Capture: the dialog popup stops arrow keys from bubbling to the page.
  useEventListener(
    single ? null : document,
    "keydown",
    (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // Leave modified arrows (back and forward) and caret moves in a field above the lightbox alone.
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
    },
    true,
  );
  if (!current) return null;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        onClick={(event) => {
          if (!(event.target as Element).closest("button")) onClose();
        }}
        className="flex h-[min(88vh,52rem)] w-[min(94vw,60rem)] max-w-none flex-col gap-0 bg-transparent p-0 shadow-none ring-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{current.name}</DialogTitle>
        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          <LightboxPicture key={selectedKey} image={current} />
          <DialogClose
            ref={close}
            render={
              <Button
                variant="floating"
                size="icon-sm"
                aria-label={t`Close image preview`}
                className="absolute end-2 top-2"
              />
            }
          >
            <X strokeWidth={1.8} />
          </DialogClose>
          {single ? null : (
            <>
              <Button
                variant="floating"
                size="icon-lg"
                aria-label={t`Previous image`}
                onClick={() => step(-1)}
                className="absolute left-1 top-1/2 -translate-y-1/2 sm:-left-6"
              >
                <ChevronLeft strokeWidth={1.8} />
              </Button>
              <Button
                variant="floating"
                size="icon-lg"
                aria-label={t`Next image`}
                onClick={() => step(1)}
                className="absolute right-1 top-1/2 -translate-y-1/2 sm:-right-6"
              >
                <ChevronRight strokeWidth={1.8} />
              </Button>
            </>
          )}
        </div>
        {single ? null : (
          <div className="mt-4 shrink-0 pb-1">
            <div className="relative h-24 overflow-hidden [perspective:900px]">
              {images.map((image, position) => {
                const offset = position - index;
                const distance = Math.abs(offset);
                if (distance > 3) return null;
                return (
                  <div
                    key={galleryImageKey(image)}
                    className="absolute left-1/2 top-1/2 transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none"
                    style={{
                      transform: `translate(-50%, -50%) translateX(${offset * 88}px) translateZ(${-distance * 28}px) scale(${1 - distance * 0.2})`,
                      opacity: distance === 0 ? 1 : 0.35,
                      zIndex: images.length - distance,
                    }}
                  >
                    <GalleryThumb
                      image={image}
                      active={distance === 0}
                      onSelect={() => onSelect(galleryImageKey(image))}
                      // Clipped neighbours stay out of the tab order; the arrows reach every image.
                      tabIndex={distance > 1 ? -1 : undefined}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-1 text-center text-label text-muted-foreground tabular-nums">
              {index + 1} / {images.length}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
