import { useLingui } from "@lingui/react/macro";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { cn } from "@rakazo/ui-web/lib/utils";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { useArtifactImage } from "../../lib/use-artifact-image";
import { useEventListener } from "../../lib/use-event-listener";

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
  const [openAt, setOpenAt] = useState<number | null>(null);
  const open = useMemo(() => {
    const positions = new Map(images.map((image, index) => [galleryImageKey(image), index]));
    return (image: GalleryImage) => {
      const index = positions.get(galleryImageKey(image));
      if (index !== undefined) setOpenAt(index);
    };
  }, [images]);
  return (
    <ImageGalleryContext.Provider value={open}>
      {children}
      {openAt !== null && images[openAt] ? (
        <ImageLightbox images={images} start={openAt} onClose={() => setOpenAt(null)} />
      ) : null}
    </ImageGalleryContext.Provider>
  );
}

function GalleryThumb({
  image,
  active,
  onSelect,
  buttonRef,
}: {
  image: GalleryImage;
  active: boolean;
  onSelect: () => void;
  buttonRef?: (button: HTMLButtonElement | null) => void;
}) {
  const { t } = useLingui();
  const src = useArtifactImage(image.target, image.artifactId);
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={t`Show ${image.name}`}
      aria-current={active || undefined}
      onClick={onSelect}
      className={cn(
        "size-14 shrink-0 overflow-hidden rounded-lg bg-muted ring-offset-2 ring-offset-muted/60 transition-[opacity,box-shadow]",
        active ? "ring-2 ring-ring" : "opacity-60 hover:opacity-100",
      )}
    >
      {src ? (
        <img src={src} alt="" loading="lazy" className="size-full object-cover" />
      ) : (
        <span className="block size-full" />
      )}
    </button>
  );
}

/**
 * The picture at full size over the page, with the chat's other pictures beside it: arrows and
 * the carousel move through them, and the arrow keys, Escape or a click dismiss the lightbox.
 */
export function ImageLightbox(props: {
  images: GalleryImage[];
  start: number;
  onClose: () => void;
}) {
  if (!(props.images[props.start] ?? props.images[0])) return null;
  return <LightboxView {...props} />;
}

function LightboxView({
  images,
  start,
  onClose,
}: {
  images: GalleryImage[];
  start: number;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [index, setIndex] = useState(start);
  const current = (images[index] ?? images[0])!;
  const src = useArtifactImage(current.target, current.artifactId);
  const close = useRef<HTMLButtonElement>(null);
  const activeThumb = useRef<HTMLButtonElement | null>(null);
  const single = images.length < 2;
  const step = (delta: number) =>
    setIndex((position) => (position + delta + images.length) % images.length);

  useEffect(() => {
    close.current?.focus();
  }, []);
  useEffect(() => {
    activeThumb.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [index]);
  // Capture: the dialog popup stops arrow keys from bubbling to the page.
  useEventListener(
    single ? null : document,
    "keydown",
    (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
    },
    true,
  );

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex w-[min(94vw,60rem)] max-w-none flex-col gap-0 bg-transparent p-0 shadow-none ring-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{current.name}</DialogTitle>
        <div className="relative flex min-h-0 items-center justify-center">
          {src ? (
            // biome-ignore lint/a11y/useKeyWithClickEvents: Escape and the close button cover the keyboard.
            <img
              src={src}
              alt={current.name}
              onClick={onClose}
              className="max-h-[72vh] max-w-full cursor-zoom-out rounded-xl object-contain"
            />
          ) : (
            <div className="h-[40vh] w-full rounded-xl bg-muted" />
          )}
          {single ? null : (
            <>
              <Button
                variant="floating"
                size="icon-lg"
                aria-label={t`Previous image`}
                onClick={() => step(-1)}
                className="absolute left-2 top-1/2 -translate-y-1/2"
              >
                <ChevronLeft strokeWidth={1.8} />
              </Button>
              <Button
                variant="floating"
                size="icon-lg"
                aria-label={t`Next image`}
                onClick={() => step(1)}
                className="absolute right-2 top-1/2 -translate-y-1/2"
              >
                <ChevronRight strokeWidth={1.8} />
              </Button>
            </>
          )}
          <DialogClose
            ref={close}
            render={
              <Button
                variant="floating"
                size="icon-sm"
                aria-label={t`Close image preview`}
                className="absolute right-2 top-2"
              />
            }
          >
            <X strokeWidth={1.8} />
          </DialogClose>
        </div>
        {single ? null : (
          <div className="mt-3 flex items-center gap-3">
            <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto rounded-xl bg-muted/60 p-2 backdrop-blur">
              {images.map((image, position) => (
                <GalleryThumb
                  key={galleryImageKey(image)}
                  image={image}
                  active={position === index}
                  onSelect={() => setIndex(position)}
                  buttonRef={
                    position === index ? (button) => (activeThumb.current = button) : undefined
                  }
                />
              ))}
            </div>
            <span className="shrink-0 text-body-sm text-muted-foreground tabular-nums">
              {index + 1} / {images.length}
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
