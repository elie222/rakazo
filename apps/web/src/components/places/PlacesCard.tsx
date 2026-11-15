import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { PlacesCard as PlacesCardData } from "@rakazo/contracts";
import {
  clusterPlaces,
  fitViewport,
  formatDistance,
  frameTiles,
  placeMapsUrl,
  projectToFrame,
  usesMiles,
} from "@rakazo/core";
import { MapPin } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const FALLBACK_WIDTH = 640;
/** Rows shown before "Show more". */
const COLLAPSED_ROWS = 5;
/** Closest two pins sit before they merge into one counted group, in pixels. */
const PIN_SPACING = 30;

/** The frame's width in pixels, kept current as the message column resizes. */
function useFrameWidth() {
  const ref = useRef<HTMLFieldSetElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function Tile({ url, left, top }: { url: string; left: number; top: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      draggable={false}
      referrerPolicy="strict-origin-when-cross-origin"
      onError={() => setFailed(true)}
      className="pointer-events-none absolute size-64 max-w-none select-none"
      style={{ left, top }}
    />
  );
}

function PlacesMap({
  card,
  places,
  map,
  selected,
  onSelect,
  onExpand,
}: {
  card: PlacesCardData;
  /** The places whose rows are showing; the map draws pins for these only. */
  places: PlacesCardData["places"];
  map: NonNullable<PlacesCardData["map"]>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onExpand: () => void;
}) {
  const { t } = useLingui();
  const { ref, width } = useFrameWidth();
  const height = width <= 360 ? 240 : 280;
  const count = card.places.length;
  const label = t`${plural(count, { one: "# place", other: "# places" })}`;
  const fitted = useMemo(() => fitViewport(places, width, height), [places, width, height]);
  const [focused, setFocused] = useState<ReturnType<typeof fitViewport> | null>(null);
  const viewport = focused ?? fitted;
  const clusters = useMemo(
    () => clusterPlaces(places, viewport.zoom, PIN_SPACING),
    [places, viewport.zoom],
  );
  const tiles = useMemo(
    () => frameTiles(map.tileUrl, viewport, width, height),
    [map.tileUrl, viewport, width, height],
  );
  const centre = card.centre ? projectToFrame(card.centre, viewport, width, height) : null;
  return (
    <fieldset
      ref={ref}
      dir="ltr"
      aria-label={t`Places on a map`}
      className="relative isolate m-0 w-full min-w-0 overflow-hidden rounded-2xl border-0 bg-secondary p-0"
      style={{ height }}
    >
      {tiles.map((tile) => (
        <Tile key={tile.key} url={tile.url} left={tile.left} top={tile.top} />
      ))}
      {centre ? (
        <span
          aria-hidden="true"
          className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-link ring-2 ring-card"
          style={{ left: centre.left, top: centre.top }}
        />
      ) : null}
      {clusters.map((cluster) => {
        const at = projectToFrame(cluster, viewport, width, height);
        const [only] = cluster.members;
        if (cluster.members.length === 1 && only) {
          const active = selected === only.id;
          return (
            <span
              key={cluster.id}
              aria-hidden="true"
              data-pin={card.places.indexOf(only) + 1}
              data-selected={active || undefined}
              onMouseEnter={() => onSelect(only.id)}
              onMouseLeave={() => onSelect(null)}
              className="absolute flex size-[26px] origin-center -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary font-medium text-caption text-primary-foreground shadow-md ring-2 ring-card transition-transform data-selected:z-10 data-selected:scale-125"
              style={{ left: at.left, top: at.top }}
            >
              {card.places.indexOf(only) + 1}
            </span>
          );
        }
        const groupLabel = t`${plural(cluster.members.length, { one: "# place", other: "# places" })}`;
        return (
          <button
            key={cluster.id}
            type="button"
            aria-label={groupLabel}
            title={groupLabel}
            data-group={cluster.members.length}
            onClick={() => {
              const fit = fitViewport(cluster.members, width, height);
              // Zoom in on the group; one that cannot be pulled apart opens the whole list.
              if (fit.zoom > viewport.zoom) setFocused(fit);
              else onExpand();
            }}
            className="absolute z-10 flex size-[30px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-muted-foreground font-medium text-caption text-background shadow-md ring-2 ring-card outline-none focus-visible:ring-ring"
            style={{ left: at.left, top: at.top }}
          >
            {cluster.members.length}
          </button>
        );
      })}
      <span className="absolute start-3 top-3 z-20 flex h-8 items-center rounded-full bg-card px-3 font-medium text-body text-foreground shadow-sm ring-[0.5px] ring-border">
        {label}
      </span>
      <span className="absolute end-2 bottom-1 z-20 max-w-[70%] truncate rounded bg-card/80 px-1 text-caption text-muted-foreground">
        {map.attribution}
      </span>
    </fieldset>
  );
}

function Row({
  place,
  index,
  selected,
  onSelect,
}: {
  place: PlacesCardData["places"][number];
  index: number;
  selected: boolean;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useLingui();
  const language = typeof navigator === "undefined" ? undefined : navigator.language;
  const distance =
    place.distanceM === undefined
      ? undefined
      : formatDistance(place.distanceM, usesMiles(language), language);
  const meta = [place.category, distance].filter(Boolean).join(" · ");
  const openInMaps = t`Open in Maps`;
  return (
    <li
      data-selected={selected || undefined}
      onMouseEnter={() => onSelect(place.id)}
      onMouseLeave={() => onSelect(null)}
      onFocus={() => onSelect(place.id)}
      onBlur={() => onSelect(null)}
      className="flex min-h-16 items-center gap-3 rounded-2xl py-2 ps-2.5 pe-1 data-selected:bg-foreground/[0.06]"
    >
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary font-medium text-caption text-primary-foreground"
      >
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-body text-foreground">{place.name}</p>
        {meta ? <p className="truncate text-body text-muted-foreground">{meta}</p> : null}
        {place.address ? (
          <p className="truncate text-body text-muted-foreground">{place.address}</p>
        ) : null}
        {place.hours ? (
          <p title={place.hours} className="truncate text-caption text-muted-foreground/70">
            {place.hours}
          </p>
        ) : null}
      </div>
      <a
        href={placeMapsUrl(place, "web")}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${openInMaps}: ${place.name}`}
        title={openInMaps}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MapPin aria-hidden="true" className="size-5" />
      </a>
    </li>
  );
}

/** Places the bot looked up: a map with numbered pins above a list of the same places. */
export function PlacesCard({ card }: { card: PlacesCardData }) {
  const { t } = useLingui();
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const visiblePlaces = useMemo(
    () => (expanded ? card.places : card.places.slice(0, COLLAPSED_ROWS)),
    [expanded, card.places],
  );
  const attributionHref = card.attribution.url.startsWith("https://")
    ? card.attribution.url
    : undefined;
  return (
    <section
      data-testid="places-card"
      aria-label={t`Places`}
      className="w-full max-w-[708px] rounded-[22px] bg-card p-1.5 text-foreground shadow-sm ring-[0.5px] ring-border"
    >
      {card.map ? (
        <PlacesMap
          key={expanded ? "all" : "some"}
          card={card}
          places={visiblePlaces}
          map={card.map}
          selected={selected}
          onSelect={setSelected}
          onExpand={() => setExpanded(true)}
        />
      ) : (
        <span
          data-testid="places-count"
          className="mx-1.5 mt-1.5 mb-0.5 inline-flex h-8 items-center rounded-full bg-secondary px-3 font-medium text-body text-foreground"
        >
          {t`${plural(card.places.length, { one: "# place", other: "# places" })}`}
        </span>
      )}
      <ul className="m-0 list-none p-0 pt-1">
        {visiblePlaces.map((place, index) => (
          <Row
            key={place.id}
            place={place}
            index={index}
            selected={selected === place.id}
            onSelect={setSelected}
          />
        ))}
      </ul>
      {card.places.length > COLLAPSED_ROWS ? (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="mx-1.5 mt-1 h-11 w-[calc(100%-12px)] rounded-2xl text-body text-muted-foreground outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? t`Show less` : t`Show more`}
        </button>
      ) : null}
      <div className="px-3 pt-1 pb-2 text-end text-caption text-muted-foreground">
        {attributionHref ? (
          <a
            href={attributionHref}
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 hover:underline"
          >
            {card.attribution.name}
          </a>
        ) : (
          <span>{card.attribution.name}</span>
        )}
      </div>
    </section>
  );
}
