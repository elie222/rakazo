import type { CSSProperties, ReactNode } from "react";
import { Children, useEffect, useId, useRef, useState } from "react";
import { LinkButton, linkUrl, ReplyButton } from "./controls.js";
import { graphemes } from "./graphemes.js";
import { openViaHost } from "./inline.js";
import type { Words } from "./labels.js";
import { useWords } from "./labels.js";

const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() : "";

const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+[;,]/i;
const PAGE_IMAGE = "image:";
let pageImages = new Map<string, string>();

export function setPageImages(images: unknown) {
  pageImages = new Map(
    images && typeof images === "object"
      ? Object.entries(images).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" && DATA_IMAGE.test(entry[1]),
        )
      : [],
  );
}

/** The viewer loads nothing from the network, so pictures come embedded in the page. */
function imageSource(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith(PAGE_IMAGE)) return pageImages.get(value.slice(PAGE_IMAGE.length));
  return DATA_IMAGE.test(value) ? value : undefined;
}

/** Sound and video may also be a blob the page made itself. */
function mediaSource(value: unknown, kind: "audio" | "video"): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("blob:")) return value;
  return new RegExp(`^data:${kind}/[a-z0-9.+-]+[;,]`, "i").test(value) ? value : undefined;
}

/** 1.5, "16/9" or "4:3" as width over height; anything else leaves the picture's own shape. */
export function aspectRatio(value: unknown): number | undefined {
  if (typeof value === "number") return value > 0 && Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*[/:]\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!match) return aspectRatio(Number(value) || undefined);
  const ratio = Number(match[1]) / Number(match[2]);
  return ratio > 0 && Number.isFinite(ratio) ? ratio : undefined;
}

const px = (value: unknown) =>
  typeof value === "number" && value > 0 && Number.isFinite(value) ? value : undefined;

type PictureProps = {
  src: string;
  alt: string;
  fit?: "contain" | "cover";
  style?: CSSProperties;
};

/** A soft fill shows until the current picture has drawn, then it fades in. */
function Picture(props: PictureProps) {
  return <PictureSource key={props.src} {...props} />;
}

function PictureSource({ src, alt, fit, style }: PictureProps) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLoaded(true), 8000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="rk-picture" data-loading={!loaded || undefined} style={style}>
      <img
        src={src}
        alt={alt}
        decoding="async"
        data-fit={fit === "contain" ? "contain" : undefined}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
      />
    </div>
  );
}

function boxStyle(input: { width?: unknown; height?: unknown; ratio?: unknown }) {
  const width = px(input.width);
  const height = px(input.height);
  const ratio = aspectRatio(input.ratio);
  const style: CSSProperties = {};
  if (width) style.maxWidth = width;
  if (height) style.height = height;
  else if (ratio) style.aspectRatio = String(ratio);
  return style;
}

function Caption({ children }: { children?: ReactNode }) {
  return children ? <figcaption className="rk-figcaption">{children}</figcaption> : null;
}

export function Image({
  src,
  alt,
  caption,
  fit = "cover",
  width,
  height,
  ratio,
}: {
  src?: string;
  alt?: string;
  caption?: string;
  fit?: "contain" | "cover";
  width?: number;
  height?: number;
  ratio?: number | string;
}) {
  const words = useWords();
  const source = imageSource(src);
  const [zoomed, setZoomed] = useState(false);
  if (!source) return null;
  const style = boxStyle({ width, height, ratio });
  const name = text(alt);
  return (
    <figure className="rk-figure" style={{ maxWidth: style.maxWidth }}>
      <button
        type="button"
        className="rk-zoom"
        aria-label={name ? words.t("enlarge", { name }) : words.t("enlargeImage")}
        onClick={() => setZoomed(true)}
      >
        <Picture
          src={source}
          alt={name}
          fit={fit}
          style={{ height: style.height, aspectRatio: style.aspectRatio }}
        />
      </button>
      <Caption>{text(caption)}</Caption>
      {zoomed ? <Lightbox src={source} alt={name} onClose={() => setZoomed(false)} /> : null}
    </figure>
  );
}

/** The picture at full size over the page; a click, Escape or the close button dismisses it. */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const words = useWords();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        if (event.key === "Escape") onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onClose]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape and the close button cover the keyboard.
    <div
      className="rk-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt || words.t("image")}
      onClick={onClose}
    >
      <img src={src} alt={alt} />
      <button
        ref={close}
        type="button"
        className="rk-lightbox-close"
        aria-label={words.t("close")}
        onClick={onClose}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}

export function Video({
  src,
  alt,
  poster,
  caption,
  autoplay = true,
  loop,
  controls = true,
  fit = "contain",
  width,
  height,
  ratio,
}: {
  src?: string;
  alt?: string;
  poster?: string;
  caption?: string;
  autoplay?: boolean;
  loop?: boolean;
  controls?: boolean;
  fit?: "contain" | "cover";
  width?: number;
  height?: number;
  ratio?: number | string;
}) {
  const source = mediaSource(src, "video");
  const still = imageSource(poster);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  if (!source && !still) return null;
  const style = boxStyle({ width, height, ratio: ratio ?? (height ? undefined : 16 / 9) });
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const play = autoplay !== false && !reduced;
  return (
    <figure className="rk-figure" style={{ maxWidth: style.maxWidth }}>
      {source && failed !== source ? (
        <div
          className="rk-picture"
          style={{ height: style.height, aspectRatio: style.aspectRatio }}
        >
          <video
            src={source}
            poster={still}
            aria-label={text(alt) || undefined}
            autoPlay={play}
            muted={play}
            loop={loop ?? autoplay !== false}
            controls={controls !== false}
            playsInline
            preload="metadata"
            data-fit={fit === "cover" ? "cover" : undefined}
            onError={() => setFailed(source)}
          />
        </div>
      ) : (
        <div
          className="rk-picture"
          role="img"
          aria-label={text(alt) || undefined}
          style={{ height: style.height, aspectRatio: style.aspectRatio }}
        >
          {still ? <img src={still} alt="" aria-hidden="true" /> : null}
        </div>
      )}
      <Caption>{text(caption)}</Caption>
    </figure>
  );
}

export function Audio({
  src,
  alt,
  caption,
  loop = false,
  width,
}: {
  src?: string;
  alt?: string;
  caption?: string;
  loop?: boolean;
  width?: number;
}) {
  const source = mediaSource(src, "audio");
  if (!source) return null;
  return (
    <figure className="rk-figure" style={{ maxWidth: px(width) }}>
      {/* biome-ignore lint/a11y/useMediaCaption: a page's sound clip has no caption track to offer. */}
      <audio
        className="rk-audio"
        src={source}
        aria-label={text(alt) || undefined}
        controls
        loop={loop === true}
        preload="metadata"
      />
      <Caption>{text(caption)}</Caption>
    </figure>
  );
}

type Photo = { src?: string; alt?: string };

const GALLERY_MAX = 8;

export function Gallery({
  photos,
  height = 360,
  radius = 22,
}: {
  photos?: Photo[];
  height?: number;
  radius?: number;
}) {
  const words = useWords();
  const items = (Array.isArray(photos) ? photos : [])
    .flatMap((photo) => {
      const src = imageSource(photo?.src);
      return src ? [{ src, alt: text(photo.alt) }] : [];
    })
    .slice(0, GALLERY_MAX);
  const track = useRef<HTMLDivElement>(null);
  const [chosen, setCurrent] = useState(0);
  const [zoomed, setZoomed] = useState<number>();
  if (items.length === 0) return null;
  const enlarged = zoomed === undefined ? undefined : items[zoomed];
  // Fewer photos on a later render keep the last one marked rather than none.
  const current = Math.min(chosen, items.length - 1);
  // A right-to-left track starts at zero and scrolls to negative offsets towards later photos.
  const side = (node: HTMLElement) => (getComputedStyle(node).direction === "rtl" ? -1 : 1);
  const show = (index: number, smooth = true) => {
    const node = track.current;
    if (!node) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    node.scrollTo({
      left: side(node) * index * node.clientWidth,
      behavior: smooth && !reduced ? "smooth" : "auto",
    });
    setCurrent(index);
  };
  const focusPhoto = (index: number) =>
    track.current
      ?.querySelectorAll<HTMLButtonElement>(".rk-zoom")
      [index]?.focus({ preventScroll: true });
  return (
    <section
      className="rk-gallery"
      aria-roledescription="carousel"
      aria-label={words.t("photos", { count: items.length })}
      style={{ height: px(height) ?? 360, borderRadius: px(radius) ?? 22 }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the scroller takes arrow keys to move between photos. */}
      <div
        className="rk-gallery-track"
        ref={track}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: arrow keys move between the photos.
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            const step = (event.key === "ArrowRight" ? 1 : -1) * side(event.currentTarget);
            const next = Math.min(items.length - 1, Math.max(0, current + step));
            show(next);
            if (event.target !== event.currentTarget) focusPhoto(next);
          }
        }}
        onScroll={(event) => {
          const node = event.currentTarget;
          if (node.clientWidth > 0) {
            const index = Math.round((side(node) * node.scrollLeft) / node.clientWidth);
            setCurrent(Math.min(items.length - 1, Math.max(0, index)));
          }
        }}
      >
        {items.map((photo, index) => (
          <figure
            className="rk-gallery-slide"
            key={index}
            aria-roledescription="slide"
            aria-label={words.t("slideOf", { n: index + 1, total: items.length })}
          >
            <button
              type="button"
              className="rk-zoom"
              tabIndex={index === current ? 0 : -1}
              aria-label={
                photo.alt ? words.t("enlarge", { name: photo.alt }) : words.t("enlargeImage")
              }
              onClick={() => setZoomed(index)}
            >
              <Picture src={photo.src} alt={photo.alt} style={{ height: "100%" }} />
            </button>
          </figure>
        ))}
      </div>
      {enlarged ? (
        <Lightbox src={enlarged.src} alt={enlarged.alt} onClose={() => setZoomed(undefined)} />
      ) : null}
      {items.length > 1
        ? (
            [
              ["previous", -1, current > 0],
              ["next", 1, current < items.length - 1],
            ] as const
          ).map(([way, step, shown]) =>
            shown ? (
              <button
                key={way}
                type="button"
                className="rk-gallery-arrow"
                data-way={way}
                tabIndex={-1}
                aria-label={words.t(way === "next" ? "nextPhoto" : "previousPhoto")}
                onClick={() => {
                  show(current + step, false);
                  focusPhoto(current + step);
                }}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d={way === "next" ? "M6 3.5 10.5 8 6 12.5" : "M10 3.5 5.5 8 10 12.5"} />
                </svg>
              </button>
            ) : null,
          )
        : null}
      {items.length > 1 ? (
        <div className="rk-gallery-dots">
          {items.map((_, index) => (
            <button
              key={index}
              type="button"
              aria-label={words.t("showPhoto", { n: index + 1 })}
              aria-current={index === current || undefined}
              onClick={() => show(index)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

type StripItem = {
  image?: string;
  alt?: string;
  title?: string;
  href?: string;
  price?: string;
  note?: string;
};

function PriceLine({ price, note }: { price?: unknown; note?: unknown }) {
  const amount = text(price);
  const extra = text(note);
  if (!amount && !extra) return null;
  return (
    <p className="rk-card-price">
      {amount ? <span>{amount}</span> : null}
      {amount && extra ? " · " : null}
      {extra}
    </p>
  );
}

export function PhotoStrip({
  items,
  tileWidth = 150,
  imageHeight = 150,
}: {
  items?: StripItem[];
  tileWidth?: number;
  imageHeight?: number;
}) {
  const words = useWords();
  const tiles = (Array.isArray(items) ? items : []).filter(
    (item) => item && (imageSource(item.image) || text(item.title)),
  );
  if (tiles.length === 0) return null;
  return (
    <ul className="rk-strip">
      {tiles.map((item, index) => {
        const title = text(item.title);
        const src = imageSource(item.image);
        return (
          <li className="rk-card" key={index} style={{ width: px(tileWidth) ?? 150 }}>
            {src ? (
              <div className="rk-card-media">
                <Picture
                  src={src}
                  alt={text(item.alt) || title}
                  style={{ height: px(imageHeight) ?? 150 }}
                />
              </div>
            ) : null}
            <div className="rk-card-body" data-small="true">
              {title ? <p className="rk-card-title">{title}</p> : null}
              <PriceLine price={item.price} note={item.note} />
              {linkUrl(item.href) ? (
                <div className="rk-card-action">
                  <LinkButton
                    label={words.t("view")}
                    description={title ? words.t("viewTitle", { title }) : words.t("view")}
                    href={item.href}
                  />
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Star({ fill, clip }: { fill: number; clip: string }) {
  const path = "M6 .75 7.56 4.05l3.6.45-2.64 2.49.68 3.56L6 8.8l-3.2 1.75.68-3.56L.84 4.5l3.6-.45z";
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d={path} className="rk-star-empty" />
      {fill > 0 ? (
        <>
          {fill < 1 ? (
            <clipPath id={clip}>
              <rect width={12 * fill} height="12" />
            </clipPath>
          ) : null}
          <path
            d={path}
            className="rk-star-full"
            clipPath={fill < 1 ? `url(#${clip})` : undefined}
          />
        </>
      ) : null}
    </svg>
  );
}

function clampRating(value: unknown): number | undefined {
  const rating = typeof value === "string" ? Number(value) : value;
  return typeof rating === "number" && Number.isFinite(rating)
    ? Math.min(5, Math.max(0, rating))
    : undefined;
}

function Stars({ rating }: { rating: number }) {
  const id = useId();
  return (
    <span className="rk-stars" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((index) => (
        <Star key={index} fill={Math.min(1, Math.max(0, rating - index))} clip={`${id}-${index}`} />
      ))}
    </span>
  );
}

const count = (value: unknown) => {
  const number = typeof value === "string" ? Number(value.replace(/,/g, "")) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0
    ? Math.round(number)
    : undefined;
};

const ratedLabel = (words: Words, rating: number, reviews: number | undefined) =>
  reviews ? words.t("ratedFrom", { rating, count: reviews }) : words.t("rated", { rating });

export function RatingSummary({ rating, reviews }: { rating?: number; reviews?: number }) {
  const words = useWords();
  const score = clampRating(rating);
  if (score === undefined) return null;
  const total = count(reviews);
  return (
    <div className="rk-rating" role="img" aria-label={ratedLabel(words, score, total)}>
      <span className="rk-rating-score" aria-hidden="true">
        {words.number(score, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
      </span>
      <span className="rk-rating-detail" aria-hidden="true">
        <Stars rating={score} />
        {total ? <span>{words.t("ratings", { count: total })}</span> : null}
      </span>
    </div>
  );
}

type ProductItem = {
  title?: string;
  href?: string;
  image?: string;
  alt?: string;
  price?: string;
  note?: string;
  badge?: string;
  store?: string;
  storeMark?: string;
  rating?: number;
  reviews?: number;
};

function StoreLine({ item }: { item: ProductItem }) {
  const words = useWords();
  const store = text(item.store);
  const score = clampRating(item.rating);
  if (!store && score === undefined) return null;
  const total = count(item.reviews);
  const label = [store, score !== undefined ? ratedLabel(words, score, total) : ""]
    .filter(Boolean)
    .join(", ")
    .replace(", Rated", ", rated");
  const mark = text(item.storeMark) || (graphemes(store)[0] ?? "").toUpperCase();
  return (
    <div className="rk-store" role="img" aria-label={label}>
      {store ? (
        <>
          <span className="rk-store-mark" aria-hidden="true">
            {graphemes(mark).slice(0, 2).join("")}
          </span>
          <span>{store}</span>
        </>
      ) : null}
      {store && score !== undefined ? <span aria-hidden="true">·</span> : null}
      {score !== undefined ? (
        <>
          <Stars rating={score} />
          <span>
            {words.number(score)}
            {total ? ` (${words.number(total)})` : ""}
          </span>
        </>
      ) : null}
    </div>
  );
}

function Heading({ item, compact }: { item: ProductItem; compact: boolean }) {
  const badge = text(item.badge);
  return (
    <div className="rk-card-heading">
      <p className="rk-card-title" data-large={!compact || undefined}>
        {text(item.title)}
      </p>
      {badge ? <span className="rk-badge">{badge}</span> : null}
    </div>
  );
}

export function ProductCard({
  imageHeight,
  photos,
  viewLabel,
  compact = false,
  ...item
}: ProductItem & {
  imageHeight?: number;
  photos?: string[];
  viewLabel?: string;
  compact?: boolean;
}) {
  const words = useWords();
  const title = text(item.title);
  if (!title) return null;
  const href = linkUrl(item.href);
  const pictures = (Array.isArray(photos) ? photos : []).flatMap(
    (photo) => imageSource(photo) ?? [],
  );
  const src = imageSource(item.image) ?? pictures[0];
  const height = px(imageHeight) ?? (compact ? 140 : 240);
  const media =
    pictures.length > 1 && !compact ? (
      <div className="rk-card-media">
        <Gallery
          photos={pictures.map((photo) => ({ src: photo, alt: title }))}
          height={height}
          radius={16}
        />
      </div>
    ) : src ? (
      <div className="rk-card-media">
        <Picture src={src} alt={text(item.alt) || title} style={{ height }} />
      </div>
    ) : null;
  const body = (
    <div className="rk-card-body" data-small={compact || undefined}>
      <div className="rk-card-text">
        <Heading item={item} compact={compact} />
        <PriceLine price={item.price} note={item.note} />
        <StoreLine item={item} />
      </div>
      {href && !compact ? (
        <div className="rk-card-action">
          <LinkButton
            label={text(viewLabel) || words.t("view")}
            description={text(viewLabel) ? undefined : words.t("viewTitle", { title })}
            href={href}
          />
        </div>
      ) : null}
    </div>
  );
  return (
    <div className="rk-card">
      {href && compact ? (
        <a
          className="rk-card-link"
          href={href}
          title={title}
          rel="noopener noreferrer"
          onClick={openViaHost}
        >
          {media}
          {body}
        </a>
      ) : (
        <>
          {media}
          {body}
        </>
      )}
    </div>
  );
}

function Chevron() {
  return (
    <svg className="rk-row-chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

export function ProductRows({ items }: { items?: ProductItem[] }) {
  const rows = (Array.isArray(items) ? items : []).filter((item) => item && text(item.title));
  if (rows.length === 0) return null;
  return (
    <ul className="rk-product-rows">
      {rows.map((item, index) => {
        const href = linkUrl(item.href);
        const src = imageSource(item.image);
        const inner = (
          <>
            {src ? (
              <div className="rk-product-thumb">
                <Picture src={src} alt={text(item.alt) || text(item.title)} />
              </div>
            ) : null}
            <div className="rk-card-text">
              <Heading item={item} compact={true} />
              <PriceLine price={item.price} note={item.note} />
              <StoreLine item={item} />
            </div>
            {href ? <Chevron /> : null}
          </>
        );
        return (
          <li key={index}>
            {href ? (
              <a
                className="rk-product-row"
                href={href}
                title={text(item.title)}
                rel="noopener noreferrer"
                onClick={openViaHost}
              >
                {inner}
              </a>
            ) : (
              <div className="rk-product-row">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A request the reader can hand to the bot: the bell asks it to keep an eye on something. */
export function WatchCard({
  title,
  detail,
  label,
  reply,
}: {
  title?: string;
  detail?: string;
  label?: string;
  reply?: string;
}) {
  const words = useWords();
  const heading = text(title);
  if (!heading) return null;
  return (
    <div className="rk-watch">
      <span className="rk-watch-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          <path d="M4 11.5V7.25a4 4 0 0 1 8 0v4.25l1 1H3zM6.5 13.5a1.5 1.5 0 0 0 3 0" />
        </svg>
      </span>
      <div className="rk-watch-text">
        <p className="rk-watch-title">{heading}</p>
        {text(detail) ? <p className="rk-watch-detail">{text(detail)}</p> : null}
      </div>
      <ReplyButton label={text(label) || words.t("watch")} reply={reply ?? heading} />
    </div>
  );
}

function cardsOf(children: ReactNode) {
  // toArray already drops null, undefined and booleans.
  return Children.toArray(children).filter((child) => child !== "");
}

export function CardGrid({ label, children }: { label?: string; children?: ReactNode }) {
  const cards = cardsOf(children);
  if (cards.length === 0) return null;
  return (
    <ul className="rk-card-grid" aria-label={text(label) || undefined}>
      {cards.map((card, index) => (
        <li className="rk-card-cell" key={index}>
          {card}
        </li>
      ))}
    </ul>
  );
}

export function CardCarousel({ label, children }: { label?: string; children?: ReactNode }) {
  const words = useWords();
  const cards = cardsOf(children);
  if (cards.length === 0) return null;
  return (
    <section
      className="rk-card-carousel"
      aria-roledescription="carousel"
      aria-label={text(label) || undefined}
      // Focusable so a keyboard can scroll it on a phone, where it becomes one row.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the row scrolls sideways.
      tabIndex={0}
    >
      {cards.map((card, index) => (
        <figure
          className="rk-card-cell"
          aria-roledescription="slide"
          aria-label={words.t("slideOf", { n: index + 1, total: cards.length })}
          key={index}
        >
          {card}
        </figure>
      ))}
    </section>
  );
}

const AVATAR_TONES = ["--rk-c1", "--rk-c2", "--rk-c3", "--rk-c4", "--rk-c5"];

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1);
  return letters
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toUpperCase();
}

function toneOf(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  const tone = AVATAR_TONES[hash % AVATAR_TONES.length]!;
  // Each tone names the initials' ink that reads on it: dark on the bright ones.
  return { background: `var(${tone})`, color: `var(${tone.replace("--rk-", "--rk-on-")})` };
}

const nameOf = (person: unknown) =>
  text(
    person && typeof person === "object" && "name" in person
      ? (person as { name: unknown }).name
      : person,
  );

export function Avatar({
  name,
  size = 32,
  neutral = false,
}: {
  name?: string;
  size?: number;
  neutral?: boolean;
}) {
  const who = text(name);
  if (!who) return null;
  const side = px(size) ?? 32;
  return (
    <span
      className="rk-avatar"
      role="img"
      aria-label={who}
      title={who}
      data-neutral={neutral || undefined}
      style={{
        width: side,
        height: side,
        fontSize: side > 40 ? Math.round(side * 0.27) : 12,
        ...(neutral ? {} : toneOf(who)),
      }}
    >
      <span aria-hidden="true">{initials(who)}</span>
    </span>
  );
}

export function AvatarStack({
  people,
  max = 5,
  size = 32,
  label,
}: {
  people?: (string | { name?: string })[];
  max?: number;
  size?: number;
  label?: string;
}) {
  const words = useWords();
  const names = (Array.isArray(people) ? people : []).map(nameOf).filter(Boolean);
  if (names.length === 0) return null;
  const limit = Math.max(1, Math.round(Number(max)) || 5);
  const shown = names.length > limit ? names.slice(0, limit) : names;
  const rest = names.slice(shown.length);
  const side = px(size) ?? 32;
  const listed = names.length > 4 ? names.slice(0, 4) : names;
  const more = names.length - listed.length;
  return (
    <div className="rk-avatar-stack">
      <span className="rk-avatars">
        {shown.map((who, index) => (
          <Avatar key={index} name={who} size={side} />
        ))}
        {rest.length ? (
          <span
            className="rk-avatar"
            role="img"
            aria-label={words.t("moreCount", { count: rest.length })}
            title={rest.join(", ")}
            data-more="true"
            style={{ width: side, height: side }}
          >
            <span aria-hidden="true">+{rest.length}</span>
          </span>
        ) : null}
      </span>
      {text(label) ? (
        <span className="rk-avatar-text">
          <span className="rk-avatar-label">{text(label)}</span>
          <span className="rk-avatar-names">
            {words.list(more > 0 ? [...listed, words.t("moreCount", { count: more })] : listed)}
          </span>
        </span>
      ) : null}
    </div>
  );
}
