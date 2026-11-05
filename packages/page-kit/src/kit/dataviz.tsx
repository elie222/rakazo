import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseDay } from "./calendar.js";
import type { Words } from "./labels.js";
import { useWords, wordsFor } from "./labels.js";

/** Drawn at the container's real width, so tick text keeps its size on a phone. */
export function useWidth(fallback: number) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => setElement(node), []);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { ref, width };
}

type TipRow = { name?: ReactNode; value: ReactNode; color?: string };
type TipState = { x: number; y: number; title?: ReactNode; rows: TipRow[] };

/** The exact figures under the pointer or keyboard focus, in a small card above the point. */
export function ChartTip({ tip, width }: { tip: TipState | null; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x, 64), Math.max(64, width - 64));
  return (
    <div className="rk-tip" style={{ left, top: tip.y }} role="presentation">
      {tip.title != null && tip.title !== "" ? (
        <div className="rk-tip-title">{tip.title}</div>
      ) : null}
      {tip.rows.map((row, index) => (
        <div className="rk-tip-row" key={index}>
          {row.color ? <span className="rk-tip-swatch" style={{ background: row.color }} /> : null}
          {row.name != null && row.name !== "" ? <span>{row.name}</span> : null}
          <b>{row.value}</b>
        </div>
      ))}
    </div>
  );
}

/**
 * One highlighted item at a time, picked by pointer or by the arrow keys once the chart has
 * focus, so the figures in the tip are reachable without a mouse.
 */
export function useActive(count: number, indexAt: (x: number, y: number) => number | null) {
  const [active, setActive] = useState<number | null>(null);
  const current = active !== null && active < count ? active : null;
  const onPointerMove = (event: PointerEvent<Element>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setActive(indexAt(event.clientX - box.left, event.clientY - box.top));
  };
  const onKeyDown = (event: KeyboardEvent<Element>) => {
    if (count === 0) return;
    const keys: Record<string, number> = {
      ArrowRight: (current ?? -1) + 1,
      ArrowDown: (current ?? -1) + 1,
      ArrowLeft: (current ?? count) - 1,
      ArrowUp: (current ?? count) - 1,
      Home: 0,
      End: count - 1,
    };
    if (event.key === "Escape") {
      setActive(null);
      return;
    }
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setActive(Math.min(count - 1, Math.max(0, next)));
  };
  return {
    active: current,
    setActive,
    props: {
      tabIndex: count > 0 ? 0 : undefined,
      onPointerMove,
      // A tap on a touch screen picks the item under the finger, as hovering does.
      onPointerDown: onPointerMove,
      onPointerLeave: () => setActive(null),
      onKeyDown,
      onBlur: () => setActive(null),
    },
  };
}

export const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const numbers = (values: unknown): number[] => (Array.isArray(values) ? values.filter(finite) : []);

/** Three named hues, then everything else in one neutral grey. */
export function seriesColor(index: number): string {
  return index < 3 ? `var(--rk-c${index + 1})` : "var(--rk-other)";
}

/** Round tick steps (1, 2, 2.5 or 5 times a power of ten) covering the domain. */
function niceStep(low: number, high: number, count = 4): number {
  const raw = (high - low) / count;
  if (!(raw > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((factor) => factor * power >= raw) ?? 10) * power;
}

const ROUND_TOPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** The next round value at or above the data, so the top gridline reads cleanly. */
function niceCeiling(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return (ROUND_TOPS.find((factor) => factor * power >= value - 1e-9 * power) ?? 10) * power;
}

/** Floor, middle and top: enough to read the scale without a ruler. */
export function valueScale(values: number[], floor?: number, ceiling?: number) {
  const low = finite(floor) ? floor : Math.min(0, ...values);
  let high = finite(ceiling) ? ceiling : Math.max(low, ...values);
  if (!finite(ceiling)) high = low + niceCeiling(high - low);
  if (!(high > low)) high = low + 1;
  // On a wide scale the middle is a whole number, so it reads 206 rather than 205.5; a
  // round top such as 25 keeps its exact middle, 12.5.
  const middle = (low + high) / 2;
  return { low, high, ticks: [low, high - low >= 100 ? Math.round(middle) : middle, high] };
}

export type Formatter = (value: number) => ReactNode;

/** A caller's format wins; otherwise the figure, then the unit after a thin gap ("30 %"). */
export function formatValue(
  value: number,
  unit?: string,
  format?: Formatter,
  words: Words = wordsFor(undefined),
): string {
  if (typeof format === "function") {
    try {
      const out = format(value);
      if (typeof out === "string" || typeof out === "number") return String(out);
    } catch {
      // A broken formatter falls back to the plain figure rather than losing the chart.
    }
  }
  const text = words.number(
    value,
    Math.abs(value) >= 100_000
      ? { notation: "compact", maximumFractionDigits: 1 }
      : { maximumFractionDigits: 2 },
  );
  return unit ? withUnit(text, unit) : text;
}

// Currency symbols lead the figure, short scale and percent marks follow it closely, and words
// ("ms", "users") follow after a space: $12, 40%, 80K, 120 ms.
function withUnit(text: string, unit: string): string {
  if (/^\p{Sc}$/u.test(unit))
    return text.startsWith("-") ? `-${unit}${text.slice(1)}` : `${unit}${text}`;
  if (/^(?:%|‰|[kKMBT]|bn)$/.test(unit)) return `${text}${unit}`;
  return `${text} ${unit}`;
}

/** About how wide 12px tick text is, so the axis gutter fits its longest label. */
export const textWidth = (text: string, size = 12) => text.length * size * 0.55;

const TICK = { size: 12, gap: 8, minLabel: 36 };

export function axisGutter(labels: string[]) {
  const widest = Math.max(TICK.minLabel - 2, ...labels.map((label) => textWidth(label) + 2));
  return Math.ceil(widest + 8 + TICK.gap);
}

/** Which x labels to print: every nth, always the last, never two crowded together. */
function thinLabels(count: number, room: number, labelWidth: number, most = 6): number[] {
  if (count <= 0) return [];
  const fits = Math.max(2, Math.min(most, Math.floor(room / Math.max(labelWidth, 1))));
  const step = Math.max(1, Math.ceil(count / fits));
  const shown: number[] = [];
  for (let index = 0; index < count; index += step) shown.push(index);
  const last = count - 1;
  if (shown[shown.length - 1] !== last) {
    if (shown.length > 1 && last - shown[shown.length - 1]! < step * 0.75) shown.pop();
    shown.push(last);
  }
  return shown;
}

export type LegendItem = { name: ReactNode; color: string; mark?: "dot" | "line" | "dash" };

/** The series key above a chart: dots for filled marks, short strokes for lines. */
export function SeriesLegend({ items, small }: { items: LegendItem[]; small?: boolean }) {
  if (items.length < 1) return null;
  return (
    <ul className="rk-key">
      {items.map((item, index) => (
        <li className="rk-key-item" key={index}>
          {item.mark === "line" || item.mark === "dash" ? (
            <svg className="rk-key-line" width="14" height="2" aria-hidden="true">
              <line
                x1="0"
                x2="14"
                y1="1"
                y2="1"
                style={{ stroke: item.color }}
                strokeWidth="2"
                strokeDasharray={item.mark === "dash" ? "3 2" : undefined}
              />
            </svg>
          ) : (
            <span
              className="rk-key-dot"
              data-small={small || undefined}
              style={{ background: item.color }}
              aria-hidden="true"
            />
          )}
          {item.name}
        </li>
      ))}
    </ul>
  );
}

/** The y axis: a faint gridline and a label for each tick, labels right-aligned in the gutter. */
export function ValueGrid({
  ticks,
  y,
  left,
  right,
  label,
}: {
  ticks: number[];
  y: (value: number) => number;
  left: number;
  right: number;
  label: (value: number) => string;
}) {
  return (
    <>
      {ticks.map((tick, index) => (
        <g key={index}>
          <line className="rk-grid-line" x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
          <text className="rk-tick" x={left - TICK.gap} y={y(tick)} dy="0.35em" textAnchor="end">
            {label(tick)}
          </text>
        </g>
      ))}
    </>
  );
}

const describe = (parts: string[]) => parts.filter(Boolean).join("; ");
const text = (node: unknown) =>
  typeof node === "string" || typeof node === "number" ? String(node) : "";

// Charts have a fixed plot height so a grid of them lines up; labels sit below the plot.
const PLOT = { height: 264, top: 10, bottom: 22, right: 4 };

/** A rounded-top column path; `round` is the corner radius, `flat` keeps the bottom square. */
function columnPath(
  x: number,
  top: number,
  width: number,
  bottom: number,
  round: number,
  flat = true,
) {
  const r = Math.max(0, Math.min(round, width / 2, (bottom - top) / 2));
  const b = flat ? 0 : r;
  return (
    `M${x + r} ${top}H${x + width - r}A${r} ${r} 0 0 1 ${x + width} ${top + r}` +
    `V${bottom - b}A${b} ${b} 0 0 1 ${x + width - b} ${bottom}H${x + b}` +
    `A${b} ${b} 0 0 1 ${x} ${bottom - b}V${top + r}A${r} ${r} 0 0 1 ${x + r} ${top}Z`
  );
}

type ColumnPoint = { label?: ReactNode; value: number; display?: ReactNode };

/** Vertical columns with their value on top; the largest is inked and the rest recede. */
export function Columns({
  points = [],
  emphasis,
}: {
  points?: ColumnPoint[];
  emphasis?: number | "none";
}) {
  const words = useWords();
  const { ref, width } = useWidth(560);
  const shown = (Array.isArray(points) ? points : []).filter((point) => finite(point?.value));
  const gap = 8;
  const slot = (width - gap * Math.max(0, shown.length - 1)) / Math.max(1, shown.length);
  const hover = useActive(shown.length, (x) =>
    shown.length ? Math.min(shown.length - 1, Math.max(0, Math.floor(x / (slot + gap)))) : null,
  );
  if (shown.length === 0) return <EmptyChart />;
  const values = shown.map((point) => point.value);
  const max = Math.max(0, ...values);
  const chosen = emphasis === undefined ? values.indexOf(max) : emphasis;
  const column = Math.max(2, Math.min(28, slot * 0.7));
  const baseline = PLOT.height - PLOT.bottom;
  const tallest = baseline - 20;
  const labelWidth = Math.max(...shown.map((point) => textWidth(text(point.label)) + 6));
  const labelled = new Set(thinLabels(shown.length, width, Math.max(labelWidth, slot), 40));
  const valueRoom = slot >= Math.max(...shown.map((p) => textWidth(text(p.display ?? p.value))));
  const center = (index: number) => index * (slot + gap) + slot / 2;
  const heightOf = (v: number) => (max > 0 && v > 0 ? (v / max) * tallest : 0);
  const active = hover.active;
  return (
    <div className="rk-chart rk-frame" ref={ref}>
      <div className="rk-plot">
        <svg
          role="img"
          className="rk-focus-ring"
          width={width}
          height={PLOT.height}
          viewBox={`0 0 ${width} ${PLOT.height}`}
          {...hover.props}
        >
          <title>
            {describe(
              shown.map((point) => `${text(point.label)}: ${text(point.display ?? point.value)}`),
            )}
          </title>
          {max === 0 && values.every((value) => value === 0) ? (
            // Nothing rises, so the baseline and a note keep the chart from reading as broken.
            <>
              <line className="rk-grid-line" x1={0} x2={width} y1={baseline} y2={baseline} />
              <text className="rk-column-value" x={width / 2} y={baseline / 2} textAnchor="middle">
                {words.t("allZero")}
              </text>
            </>
          ) : null}
          {shown.map((point, index) => {
            const inked = chosen === "none" || chosen === index;
            const height = heightOf(point.value);
            const top = baseline - height;
            return (
              <g
                key={index}
                data-emphasis={inked || undefined}
                data-dim={active !== null && active !== index ? true : undefined}
              >
                {height > 0 ? (
                  <path
                    className="rk-column"
                    d={columnPath(center(index) - column / 2, top, column, baseline, 6)}
                    style={{
                      fill: inked ? "var(--rk-c1)" : "var(--rk-rest)",
                    }}
                  />
                ) : null}
                {valueRoom || inked ? (
                  <text
                    className="rk-column-value"
                    x={center(index)}
                    y={top - 6}
                    textAnchor="middle"
                  >
                    {point.display ?? point.value}
                  </text>
                ) : null}
                {labelled.has(index) ? (
                  <text
                    className="rk-tick rk-column-label"
                    x={center(index)}
                    y={PLOT.height - 4}
                    textAnchor="middle"
                  >
                    {point.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        <ChartTip
          width={width}
          tip={
            active === null
              ? null
              : {
                  x: center(active),
                  y: baseline - heightOf(shown[active]!.value) - 4,
                  title: shown[active]!.label,
                  rows: [
                    {
                      value:
                        shown[active]!.display ??
                        formatValue(shown[active]!.value, undefined, undefined, words),
                    },
                  ],
                }
          }
        />
      </div>
    </div>
  );
}

export type Series = { name: ReactNode; values: number[] };

/** Several series per label, side by side or stacked, with an optional reference line. */
export function ColumnSeries({
  labels = [],
  series = [],
  stacked = false,
  ceiling,
  unit,
  format,
  reference,
  legend = true,
}: {
  labels?: ReactNode[];
  series?: Series[];
  stacked?: boolean;
  ceiling?: number;
  unit?: string;
  format?: Formatter;
  reference?: { value: number; label?: ReactNode };
  legend?: boolean;
}) {
  const words = useWords();
  const { ref, width } = useWidth(560);
  const rows = (Array.isArray(series) ? series : []).filter(
    (item) => item && Array.isArray(item.values),
  );
  const names = Array.isArray(labels) ? labels : [];
  const count = Math.max(names.length, ...rows.map((item) => item.values.length), 0);
  const value = (item: Series, index: number) => {
    const v = item.values[index];
    return finite(v) && v > 0 ? v : 0;
  };
  const totals = Array.from({ length: count }, (_, index) =>
    stacked
      ? rows.reduce((sum, item) => sum + value(item, index), 0)
      : Math.max(0, ...rows.map((item) => value(item, index))),
  );
  const referenceValue = reference && finite(reference.value) ? reference.value : undefined;
  const scale = valueScale(
    [...totals, ...(referenceValue === undefined ? [] : [referenceValue])],
    0,
    ceiling,
  );
  const label = (tick: number) => formatValue(tick, unit, format, words);
  const left = axisGutter(scale.ticks.map(label));
  // The reference label sits above its line, so a long one never squeezes the columns.
  const right = width - PLOT.right;
  const slot = (right - left) / Math.max(1, count);
  const hover = useActive(count, (x) =>
    x < left || x > right ? null : Math.min(count - 1, Math.floor((x - left) / slot)),
  );
  if (rows.length === 0 || count === 0 || !totals.some((total) => total > 0)) return <EmptyChart />;
  const top = PLOT.top;
  const baseline = PLOT.height - PLOT.bottom;
  const y = (v: number) =>
    baseline -
    ((Math.min(scale.high, Math.max(scale.low, v)) - scale.low) / (scale.high - scale.low)) *
      (baseline - top);
  // The gap narrows with the slot, so many labels never leave a column less than nothing.
  const gap = Math.min(2, (slot * 0.62) / (4 * rows.length));
  const group = stacked
    ? Math.min(28, slot * 0.62)
    : Math.min(slot * 0.62, rows.length * 28 + (rows.length - 1) * gap);
  const bar = stacked ? group : (group - gap * (rows.length - 1)) / rows.length;
  const labelWidth = Math.max(...names.map((name) => textWidth(text(name)) + 8), 1);
  const labelled = new Set(thinLabels(count, right - left, Math.max(labelWidth, slot), 40));
  const active = hover.active;
  const description = describe(
    Array.from(
      { length: count },
      (_, index) =>
        `${text(names[index])}: ${rows.map((item) => `${text(item.name)} ${label(value(item, index))}`).join(", ")}`,
    ),
  );
  return (
    <div className="rk-chart rk-frame" ref={ref}>
      {legend !== false && rows.length > 1 ? (
        <SeriesLegend
          items={rows.map((item, index) => ({
            name: item.name,
            color: seriesColor(index),
            mark: stacked ? "dot" : "line",
          }))}
        />
      ) : null}
      <div className="rk-plot">
        <svg
          role="img"
          className="rk-focus-ring"
          width={width}
          height={PLOT.height}
          viewBox={`0 0 ${width} ${PLOT.height}`}
          {...hover.props}
        >
          <title>{description}</title>
          <ValueGrid ticks={scale.ticks} y={y} left={left} right={right} label={label} />
          {Array.from({ length: count }, (_, index) => {
            const start = left + index * slot + (slot - group) / 2;
            let sum = 0;
            return (
              <g key={index} data-dim={active !== null && active !== index ? true : undefined}>
                {rows.map((item, seriesIndex) => {
                  const v = value(item, index);
                  if (v <= 0) return null;
                  const style = {
                    fill: seriesColor(seriesIndex),
                  };
                  if (stacked) {
                    const bottom = y(sum) - (sum > 0 ? gap : 0);
                    sum += v;
                    const topEdge = y(sum);
                    if (bottom - topEdge < 0.5) return null;
                    return (
                      <path
                        key={seriesIndex}
                        d={columnPath(start, topEdge, bar, bottom, 2, bottom >= baseline)}
                        style={style}
                      />
                    );
                  }
                  return (
                    <path
                      key={seriesIndex}
                      d={columnPath(start + seriesIndex * (bar + gap), y(v), bar, baseline, 6)}
                      style={style}
                    />
                  );
                })}
                {labelled.has(index) ? (
                  <text
                    className="rk-tick"
                    x={left + index * slot + slot / 2}
                    y={PLOT.height - 4}
                    textAnchor="middle"
                  >
                    {names[index]}
                  </text>
                ) : null}
              </g>
            );
          })}
          {referenceValue !== undefined ? (
            <ReferenceLine
              y={y(referenceValue)}
              left={left}
              right={right}
              end={right}
              label={reference?.label}
              above
            />
          ) : null}
        </svg>
        <ChartTip
          width={width}
          tip={
            active === null
              ? null
              : {
                  x: left + active * slot + slot / 2,
                  y: y(totals[active]!) - 4,
                  title: names[active],
                  rows: [
                    ...rows.map((item, i) => ({
                      name: item.name,
                      value: label(value(item, active)),
                      color: seriesColor(i),
                    })),
                    ...(stacked && rows.length > 1
                      ? [{ name: words.t("total"), value: label(totals[active]!) }]
                      : []),
                  ],
                }
          }
        />
      </div>
    </div>
  );
}

/** A dashed level across the plot, named at its right end. */
export function ReferenceLine({
  y,
  left,
  right,
  end,
  label,
  above = false,
}: {
  y: number;
  left: number;
  right: number;
  end: number;
  label?: ReactNode;
  /** The label sits on the line's right end, above it, instead of in a gutter after it. */
  above?: boolean;
}) {
  return (
    <g className="rk-reference">
      <line x1={left} x2={right} y1={y} y2={y} className="rk-reference-line" />
      {label != null && label !== "" ? (
        <text
          className="rk-reference-label"
          x={end}
          y={above ? y - 6 : y}
          dy={above ? undefined : "0.35em"}
          textAnchor="end"
        >
          {label}
        </text>
      ) : null}
    </g>
  );
}

type StackedBar = { label: ReactNode; values: number[]; display?: ReactNode };

/** One horizontal bar per row, split into named segments, with the row total after it. */
export function StackedBars({
  series = [],
  bars = [],
}: {
  series?: ReactNode[];
  bars?: StackedBar[];
}) {
  const words = useWords();
  const names = Array.isArray(series) ? series : [];
  const rows = (Array.isArray(bars) ? bars : []).filter((bar) => bar && Array.isArray(bar.values));
  const parts = (bar: StackedBar) => bar.values.map((v) => (finite(v) && v > 0 ? v : 0));
  const totals = rows.map((bar) => parts(bar).reduce((sum, v) => sum + v, 0));
  const max = Math.max(0, ...totals);
  // Parts whose total overflows draw nothing rather than NaN widths.
  if (rows.length === 0 || max <= 0 || !finite(max)) return <EmptyChart />;
  return (
    <div className="rk-chart rk-frame">
      {names.length > 1 ? (
        <SeriesLegend
          small
          items={names.map((name, index) => ({ name, color: seriesColor(index) }))}
        />
      ) : null}
      <div
        className="rk-stacked"
        role="img"
        aria-label={describe(
          rows.map(
            (bar) =>
              `${text(bar.label)}: ${parts(bar)
                .map(
                  (v, i) => `${text(names[i]) || words.t("part", { n: i + 1 })} ${words.number(v)}`,
                )
                .join(", ")}`,
          ),
        )}
      >
        {rows.map((bar, index) => (
          <div className="rk-stacked-row" key={index}>
            <span className="rk-stacked-label">{bar.label}</span>
            <span className="rk-stacked-track">
              <span
                className="rk-stacked-bar"
                style={{ width: `calc((100% - 4.5rem) * ${(totals[index]! / max).toFixed(4)})` }}
              >
                {parts(bar).map((v, i) =>
                  v > 0 ? (
                    <span
                      key={i}
                      className="rk-stacked-part"
                      style={{ flexGrow: v, background: seriesColor(i) }}
                    />
                  ) : null,
                )}
              </span>
              <span className="rk-stacked-value">{bar.display ?? totals[index]}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

type ScatterPoint = {
  x: number;
  y: number;
  size?: number;
  label?: ReactNode;
  series?: string;
};
type ScatterAxis = {
  name?: string;
  unit?: string;
  format?: Formatter;
  floor?: number;
  ceiling?: number;
};

function axisRange(values: number[], axis: ScatterAxis | undefined, count: number) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const low0 = finite(axis?.floor)
    ? axis.floor
    : Math.min(0, min) === 0 && min > 0 && min < max / 2
      ? 0
      : min;
  const high0 = finite(axis?.ceiling) ? axis.ceiling : max;
  const step = niceStep(low0, high0 > low0 ? high0 : low0 + 1, count);
  const low = finite(axis?.floor) ? axis.floor : Math.floor(low0 / step) * step;
  const high = finite(axis?.ceiling)
    ? axis.ceiling
    : Math.ceil((high0 > low0 ? high0 : low0 + 1) / step) * step;
  const ticks: number[] = [];
  for (let tick = low; tick <= high + step / 1e6 && ticks.length < 12; tick += step)
    ticks.push(Number(tick.toFixed(10)));
  return { low, high: high > low ? high : low + 1, ticks };
}

/** Dots on two value axes, coloured by series and sized by a third figure, with a trend line. */
export function Scatter({
  points = [],
  x,
  y,
  size,
  trend = false,
  legend = true,
}: {
  points?: ScatterPoint[];
  x?: ScatterAxis;
  y?: ScatterAxis;
  size?: { name?: string };
  trend?: boolean;
  legend?: boolean;
}) {
  const words = useWords();
  const { ref, width } = useWidth(560);
  const shown = (Array.isArray(points) ? points : []).filter(
    (p) => p && finite(p.x) && finite(p.y),
  );
  const height = 196;
  const top = 10;
  const bottom = height - 26;
  const xs = axisRange(shown.length ? shown.map((p) => p.x) : [0], x, 4);
  const ys = axisRange(shown.length ? shown.map((p) => p.y) : [0], y, 4);
  const yLabel = (v: number) => formatValue(v, y?.unit, y?.format, words);
  const xLabel = (v: number) => formatValue(v, x?.unit, x?.format, words);
  const left = axisGutter(ys.ticks.map(yLabel));
  const right = width - 12;
  const px = (v: number) => left + ((v - xs.low) / (xs.high - xs.low)) * (right - left);
  const py = (v: number) => bottom - ((v - ys.low) / (ys.high - ys.low)) * (bottom - top);
  const hover = useActive(shown.length, (mx, my) => {
    let best: number | null = null;
    let distance = 24 * 24;
    shown.forEach((p, index) => {
      const d = (px(p.x) - mx) ** 2 + (py(p.y) - my) ** 2;
      if (d < distance) {
        distance = d;
        best = index;
      }
    });
    return best;
  });
  if (shown.length === 0) return <EmptyChart />;
  const groups = [...new Set(shown.map((p) => (typeof p.series === "string" ? p.series : "")))];
  const colorOf = (p: ScatterPoint) =>
    seriesColor(Math.max(0, groups.indexOf(typeof p.series === "string" ? p.series : "")));
  const biggest = Math.max(0, ...shown.map((p) => (finite(p.size) && p.size > 0 ? p.size : 0)));
  const radius = (p: ScatterPoint) =>
    biggest > 0 && finite(p.size) && p.size > 0 ? Math.max(3, 8 * Math.sqrt(p.size / biggest)) : 3;
  // Least squares through every dot, clipped to the plot; dots far off it get their label.
  let fit: [number, number, number, number] | null = null;
  const outliers = new Set<number>();
  if (trend && shown.length > 1) {
    const n = shown.length;
    const mx = shown.reduce((sum, p) => sum + p.x, 0) / n;
    const my = shown.reduce((sum, p) => sum + p.y, 0) / n;
    const sxx = shown.reduce((sum, p) => sum + (p.x - mx) ** 2, 0);
    if (sxx > 0) {
      const slope = shown.reduce((sum, p) => sum + (p.x - mx) * (p.y - my), 0) / sxx;
      const at = (v: number) => my + slope * (v - mx);
      const clip = (v: number) => (slope === 0 ? v : mx + (v - my) / slope);
      let x1 = Math.min(...shown.map((p) => p.x));
      let x2 = Math.max(...shown.map((p) => p.x));
      if (at(x1) < ys.low) x1 = clip(ys.low);
      if (at(x1) > ys.high) x1 = clip(ys.high);
      if (at(x2) > ys.high) x2 = clip(ys.high);
      if (at(x2) < ys.low) x2 = clip(ys.low);
      fit = [px(x1), py(at(x1)), px(x2), py(at(x2))];
      const residuals = shown.map((p) => p.y - at(p.x));
      const spread = Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / n);
      residuals.forEach((r, index) => {
        if (spread > 0 && Math.abs(r) > 1.8 * spread && shown[index]!.label != null) {
          outliers.add(index);
        }
      });
    }
  }
  const order = shown
    .map((_, index) => index)
    .sort((a, b) => radius(shown[b]!) - radius(shown[a]!));
  const xTicks = xs.ticks.length > 6 ? xs.ticks.filter((_, i) => i % 2 === 0) : xs.ticks;
  const active = hover.active;
  const activePoint = active === null ? undefined : shown[active];
  return (
    <div className="rk-chart rk-frame" ref={ref}>
      {legend !== false && groups.length > 1 ? (
        <SeriesLegend
          items={groups.map((name, index) => ({
            name: name || words.t("other"),
            color: seriesColor(index),
          }))}
        />
      ) : null}
      <div className="rk-plot">
        <svg
          role="img"
          className="rk-focus-ring"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          {...hover.props}
        >
          <title>
            {describe([
              words.t(size?.name ? "againstSized" : "against", {
                x: x?.name ?? "x",
                y: y?.name ?? "y",
                size: size?.name ?? "",
              }),
              ...shown.map(
                (p) =>
                  `${text(p.label) || text(p.series)} ${xLabel(p.x)}, ${yLabel(p.y)}${finite(p.size) ? `, ${p.size}` : ""}`,
              ),
            ])}
          </title>
          <ValueGrid ticks={ys.ticks} y={py} left={left} right={width} label={yLabel} />
          {xTicks.map((tick, index) => (
            <text
              key={index}
              className="rk-tick"
              x={px(tick)}
              y={height - 4}
              textAnchor={index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}
            >
              {xLabel(tick)}
            </text>
          ))}
          {fit ? (
            <line className="rk-trend" x1={fit[0]} y1={fit[1]} x2={fit[2]} y2={fit[3]} />
          ) : null}
          {order.map((index) => {
            const p = shown[index]!;
            return (
              <circle
                key={index}
                className="rk-dot"
                cx={px(p.x)}
                cy={py(p.y)}
                r={radius(p) + (active === index ? 1.5 : 0)}
                data-dim={active !== null && active !== index ? true : undefined}
                style={{ fill: colorOf(p) }}
              />
            );
          })}
          {[...outliers].map((index) => {
            const p = shown[index]!;
            const flip = px(p.x) > width * 0.75;
            return (
              <text
                key={`o${index}`}
                className="rk-outlier"
                x={px(p.x) + (flip ? -1 : 1) * (radius(p) + 4)}
                y={py(p.y)}
                dy="0.35em"
                textAnchor={flip ? "end" : "start"}
              >
                {text(p.label)}
              </text>
            );
          })}
        </svg>
        <ChartTip
          width={width}
          tip={
            activePoint
              ? {
                  x: px(activePoint.x),
                  y: py(activePoint.y) - radius(activePoint) - 2,
                  title: activePoint.label ?? activePoint.series,
                  rows: [
                    { name: x?.name ?? "x", value: xLabel(activePoint.x) },
                    { name: y?.name ?? "y", value: yLabel(activePoint.y) },
                    ...(finite(activePoint.size)
                      ? [
                          {
                            name: size?.name ?? words.t("size"),
                            value: formatValue(activePoint.size, undefined, undefined, words),
                          },
                        ]
                      : []),
                  ],
                }
              : null
          }
        />
      </div>
    </div>
  );
}

const SHADES = 5;

/** Which of the five ramp steps a value falls in; nothing for zero or no value. */
export function shade(value: unknown, max: number): number | undefined {
  if (!finite(value) || value <= 0 || !(max > 0)) return undefined;
  return Math.min(SHADES, Math.max(1, Math.ceil((value / max) * SHADES)));
}

const shadeColor = (step: number | undefined) =>
  step ? `var(--rk-seq${step})` : "var(--rk-fill-strong)";

function Ramp({ low, high }: { low: string; high: string }) {
  return (
    <div className="rk-ramp" aria-hidden="true">
      <span>{low}</span>
      {Array.from({ length: SHADES }, (_, i) => (
        <span key={i} className="rk-ramp-step" style={{ background: shadeColor(i + 1) }} />
      ))}
      <span>{high}</span>
    </div>
  );
}

/** Where a cell sits inside its chart, for placing the tip over it. */
function cellTip(target: EventTarget | null, host: HTMLElement | null) {
  if (!(target instanceof HTMLElement) || !host || !target.dataset.cell) return null;
  const box = target.getBoundingClientRect();
  const frame = host.getBoundingClientRect();
  return {
    key: target.dataset.cell,
    x: box.left - frame.left + box.width / 2,
    y: box.top - frame.top,
  };
}

type CellFocus = { key: string; x: number; y: number } | null;

/** Hovering or arrowing through cells shows that cell's exact figure. */
function useCells(keys: string[]) {
  const host = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<CellFocus>(null);
  const place = (key: string) => {
    const element = host.current?.querySelector<HTMLElement>(`[data-cell="${key}"]`);
    setFocus(element ? cellTip(element, host.current) : null);
  };
  const props = {
    tabIndex: keys.length ? 0 : undefined,
    onPointerOver: (event: PointerEvent<HTMLElement>) =>
      setFocus(cellTip(event.target, host.current)),
    onPointerLeave: () => setFocus(null),
    onBlur: () => setFocus(null),
    onKeyDown: (event: KeyboardEvent<HTMLElement>, step: Record<string, number>) => {
      const index = focus ? keys.indexOf(focus.key) : -1;
      const move = event.key === "Escape" ? null : step[event.key];
      if (event.key === "Escape") setFocus(null);
      if (move === undefined || move === null) return;
      event.preventDefault();
      const next = Math.min(keys.length - 1, Math.max(0, index < 0 ? 0 : index + move));
      place(keys[next]!);
    },
  };
  return { host, focus, props };
}

/** A grid of rows by columns, each cell shaded by its value on one sequential ramp. */
const HEAT_LABEL = 24;

export function Heatmap({
  rows = [],
  columns = [],
  values = [],
  max,
}: {
  rows?: ReactNode[];
  columns?: ReactNode[];
  values?: number[][];
  max?: number;
}) {
  const words = useWords();
  const rowNames = Array.isArray(rows) ? rows : [];
  const columnNames = Array.isArray(columns) ? columns : [];
  const grid = Array.isArray(values) ? values : [];
  const cell = (r: number, c: number) => {
    const row = grid[r];
    return Array.isArray(row) ? row[c] : undefined;
  };
  const keys = rowNames.flatMap((_, r) => columnNames.map((_, c) => `${r}-${c}`));
  const cells = useCells(keys);
  const fit = useWidth(10_000);
  // Cells shrink to fit a phone; a column label then shows only every few columns, about one
  // per HEAT_LABEL pixels after the row names.
  const step = Math.max(
    1,
    Math.ceil((HEAT_LABEL * columnNames.length) / Math.max(1, fit.width - 48)),
  );
  const all = grid.flatMap((row) => numbers(row));
  const top = finite(max) && max > 0 ? max : Math.max(0, ...all);
  if (rowNames.length === 0 || columnNames.length === 0 || all.length === 0) return <EmptyChart />;
  const focus = cells.focus;
  const [fr, fc] = focus ? focus.key.split("-").map(Number) : [];
  const figure = (v: unknown) =>
    finite(v) ? formatValue(v, undefined, undefined, words) : words.t("noValue");
  return (
    <div className="rk-chart rk-frame" ref={cells.host}>
      <Ramp low={words.t("fewer")} high={words.t("rampMore")} />
      <div className="rk-heatmap-scroll" ref={fit.ref}>
        <div
          className="rk-heatmap rk-focus-ring"
          data-thin={step > 1 || undefined}
          role="img"
          aria-label={describe(
            rowNames.map(
              (row, r) =>
                `${text(row)}: ${columnNames.map((col, c) => `${text(col)} ${figure(cell(r, c))}`).join(", ")}`,
            ),
          )}
          style={{ "--rk-heat-columns": columnNames.length } as CSSProperties}
          {...cells.props}
          onKeyDown={(event) =>
            cells.props.onKeyDown(event, {
              ArrowRight: 1,
              ArrowLeft: -1,
              ArrowDown: columnNames.length,
              ArrowUp: -columnNames.length,
            })
          }
        >
          <span aria-hidden="true" />
          {columnNames.map((name, c) => (
            <span key={`c${c}`} className="rk-heatmap-column" title={text(name)}>
              {c % step === 0 ? name : null}
            </span>
          ))}
          {rowNames.map((name, r) => [
            <span key={`r${r}`} className="rk-heatmap-row" title={text(name)}>
              {name}
            </span>,
            ...columnNames.map((_, c) => (
              <span
                key={`${r}-${c}`}
                data-cell={`${r}-${c}`}
                data-active={focus?.key === `${r}-${c}` || undefined}
                className="rk-heatmap-cell"
                style={{ background: shadeColor(shade(cell(r, c), top)) }}
              />
            )),
          ])}
        </div>
      </div>
      <ChartTip
        width={cells.host.current?.clientWidth ?? 10_000}
        tip={
          focus && fr !== undefined && fc !== undefined
            ? {
                x: focus.x,
                y: focus.y,
                title: `${text(rowNames[fr])} · ${text(columnNames[fc])}`,
                rows: [{ value: figure(cell(fr, fc)) }],
              }
            : null
        }
      />
    </div>
  );
}

const DAY = 86_400_000;

const utcDay = (value: unknown) => parseDay(value)?.getTime();

/** A year-at-a-glance strip of days in week columns, Monday first, shaded by value. */
export function CalendarHeatmap({
  days = [],
  from,
  to,
  max,
  note,
}: {
  days?: { date: string; value: number }[];
  from?: string;
  to?: string;
  max?: number;
  note?: ReactNode;
}) {
  const words = useWords();
  const byDay = new Map<number, number>();
  for (const day of Array.isArray(days) ? days : []) {
    const time = utcDay(day?.date);
    if (time !== undefined && finite(day.value))
      byDay.set(time, (byDay.get(time) ?? 0) + day.value);
  }
  const known = [...byDay.keys()];
  const startGuess = utcDay(from) ?? (known.length ? Math.min(...known) : 0);
  const endGuess = Math.min(
    utcDay(to) ?? (known.length ? Math.max(...known) : 0),
    startGuess + 550 * DAY,
  );
  const keys: string[] = [];
  for (let time = startGuess; time <= endGuess && keys.length <= 551; time += DAY) {
    keys.push(new Date(time).toISOString().slice(0, 10));
  }
  const cellsFocus = useCells(keys);
  const start = utcDay(from) ?? (known.length ? Math.min(...known) : undefined);
  const end = utcDay(to) ?? (known.length ? Math.max(...known) : undefined);
  if (start === undefined || end === undefined || end < start || known.length === 0)
    return <EmptyChart />;
  // At most about a year and a half, so a stray far date cannot draw thousands of cells.
  const last = Math.min(end, start + 550 * DAY);
  const top = finite(max) && max > 0 ? max : Math.max(0, ...byDay.values());
  const weekday = (time: number) => (new Date(time).getUTCDay() + 6) % 7;
  const firstWeek = start - weekday(start) * DAY;
  const weeks = Math.floor((last - firstWeek) / DAY / 7) + 1;
  const cells: ReactNode[] = [];
  const months: ReactNode[] = [];
  let lastMonth = -1;
  let labelWeek = Number.NEGATIVE_INFINITY;
  for (let time = start; time <= last; time += DAY) {
    const date = new Date(time);
    const week = Math.floor((time - firstWeek) / DAY / 7);
    const value = byDay.get(time);
    const iso = date.toISOString().slice(0, 10);
    cells.push(
      <span
        key={iso}
        className="rk-day"
        data-cell={iso}
        data-active={cellsFocus.focus?.key === iso || undefined}
        style={{
          gridColumn: week + 2,
          gridRow: weekday(time) + 2,
          background: shadeColor(shade(value, top)),
        }}
      />,
    );
    if (date.getUTCMonth() !== lastMonth && (date.getUTCDate() <= 7 || time === start)) {
      lastMonth = date.getUTCMonth();
      // A range starting late in a month leaves its first label no room: the next one wins.
      if (week - labelWeek < 3) months.pop();
      labelWeek = week;
      months.push(
        <span
          key={`m${iso}`}
          className="rk-calendar-month"
          style={{ gridColumn: `${week + 2} / span 4`, gridRow: 1 }}
        >
          {words.date(time, { month: "short", timeZone: "UTC" })}
        </span>,
      );
    }
  }
  return (
    <div className="rk-calendar rk-frame" ref={cellsFocus.host}>
      <div className="rk-calendar-scroll">
        <div
          className="rk-calendar-grid rk-focus-ring"
          role="img"
          {...cellsFocus.props}
          onKeyDown={(event) =>
            cellsFocus.props.onKeyDown(event, {
              ArrowRight: 7,
              ArrowLeft: -7,
              ArrowDown: 1,
              ArrowUp: -1,
            })
          }
          aria-label={words.t("dailyValues", {
            from: words.date(start, { dateStyle: "medium", timeZone: "UTC" }),
            to: words.date(last, { dateStyle: "medium", timeZone: "UTC" }),
            top,
          })}
          style={{ "--rk-weeks": weeks } as CSSProperties}
        >
          {months}
          {[1, 3, 5]
            .map((day) => words.date(Date.UTC(2024, 0, day), { weekday: "short", timeZone: "UTC" }))
            .map((name, i) => (
              <span
                key={name}
                className="rk-calendar-weekday"
                style={{ gridColumn: 1, gridRow: i * 2 + 2 }}
              >
                {name}
              </span>
            ))}
          {cells}
        </div>
      </div>
      <div className="rk-calendar-foot">
        {note != null && note !== "" ? <span className="rk-calendar-note">{note}</span> : <span />}
        <Ramp low={words.t("less")} high={words.t("rampMore")} />
      </div>
      <ChartTip
        width={cellsFocus.host.current?.clientWidth ?? 10_000}
        tip={
          cellsFocus.focus
            ? {
                x: cellsFocus.focus.x,
                y: cellsFocus.focus.y,
                title: words.date(Date.parse(`${cellsFocus.focus.key}T00:00:00Z`), {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  timeZone: "UTC",
                }),
                rows: [
                  {
                    value: formatValue(
                      byDay.get(utcDay(cellsFocus.focus.key) ?? 0) ?? 0,
                      undefined,
                      undefined,
                      words,
                    ),
                  },
                ],
              }
            : null
        }
      />
    </div>
  );
}

type VennSet = { label: ReactNode; count?: number; items?: ReactNode[] };

/** Words in lines no wider than `max`, measured as the chart's labels are. */
function wrapWords(words: string, max: number): string[] {
  const lines: string[] = [];
  for (const word of words.split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && textWidth(`${last} ${word}`) <= max) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else {
      lines.push(word);
    }
  }
  return lines;
}

/** Two or three overlapping sets, each named outside its circle, with the shared figure inside. */
export function Venn({ sets = [], overlap }: { sets?: VennSet[]; overlap?: ReactNode }) {
  const words = useWords();
  const { ref, width } = useWidth(560);
  const shown = (Array.isArray(sets) ? sets : [])
    .filter((set) => set && set.label != null)
    .slice(0, 3);
  if (shown.length === 0) return <EmptyChart />;
  const r = Math.max(40, Math.min(79, (width - 160) / 3.2));
  const center = width / 2;
  const three = shown.length === 3;
  const dx = shown.length === 1 ? 0 : r * 0.754;
  const height = three ? Math.round(r * 3.16) : Math.round(r * 2 + 20);
  const cy = 10 + r;
  const circles = [
    { cx: center - dx, cy },
    { cx: center + dx, cy },
    { cx: center, cy: cy + r * 0.98 },
  ].slice(0, shown.length);
  const middle = three ? { x: center, y: (cy * 2 + cy + r * 0.98) / 3 } : { x: center, y: cy };
  const count = (set: VennSet) =>
    finite(set.count) ? set.count : Array.isArray(set.items) ? set.items.length : undefined;
  return (
    <div className="rk-chart rk-frame rk-venn" ref={ref}>
      <svg
        role="img"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-label={describe([
          ...shown.map(
            (set) =>
              `${text(set.label)}${count(set) !== undefined ? ` ${words.number(count(set)!)}` : ""}`,
          ),
          overlap != null ? words.t("shared", { value: text(overlap) }) : "",
        ])}
      >
        {circles.map((c, i) => (
          <circle
            key={i}
            className="rk-venn-set"
            cx={c.cx}
            cy={c.cy}
            r={r}
            style={{ fill: seriesColor(i), stroke: seriesColor(i) }}
          />
        ))}
        {circles.map((c, i) => {
          const set = shown[i]!;
          const leftSide = i === 0;
          const x = leftSide ? c.cx - r - 8 : c.cx + r * (i === 2 ? 0.55 : 1) + 8;
          const yText = i === 2 ? c.cy + r * 0.75 : c.cy - r * 0.5;
          const anchor = leftSide ? "end" : "start";
          return (
            <g key={`l${i}`}>
              <text className="rk-venn-name" x={x} y={yText} textAnchor={anchor}>
                {text(set.label)}
              </text>
              {count(set) !== undefined ? (
                <text className="rk-venn-count" x={x} y={yText + 16} textAnchor={anchor}>
                  {words.number(count(set)!)}
                </text>
              ) : null}
            </g>
          );
        })}
        {overlap != null && overlap !== "" && shown.length > 1
          ? (() => {
              // Wrapped to the shared middle, so a long note stays between the circles.
              const lines = wrapWords(text(overlap), Math.max(56, r * 1.1)).slice(0, 3);
              return (
                <text
                  className="rk-venn-overlap"
                  x={middle.x}
                  y={middle.y - ((lines.length - 1) * 15) / 2}
                  textAnchor="middle"
                >
                  {lines.map((line, index) => (
                    <tspan key={index} x={middle.x} dy={index === 0 ? "0.35em" : 15}>
                      {line}
                    </tspan>
                  ))}
                </text>
              );
            })()
          : null}
      </svg>
    </div>
  );
}

/** A small drawn arrow pointing to the high end of an axis. */
function Arrow() {
  return (
    <svg className="rk-axis-arrow" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1 5h7.5M5.5 2l3 3-3 3" />
    </svg>
  );
}

type MatrixPoint = { label: ReactNode; x: number; y: number };

const axisEnds = (axis: unknown): [string, string] => {
  if (Array.isArray(axis)) return [text(axis[0]), text(axis[1])];
  return ["", text(axis)];
};

/** Four quadrants on two axes from low to high, with items placed by their 0 to 1 position. */
export function Matrix2x2({
  axes,
  quadrants = [],
  points = [],
}: {
  axes?: { x?: string | [string, string]; y?: string | [string, string] };
  quadrants?: ReactNode[];
  points?: MatrixPoint[];
}) {
  const words = useWords();
  const [xLow, xHigh] = axisEnds(axes?.x);
  const [yLow, yHigh] = axisEnds(axes?.y);
  const names = Array.isArray(quadrants) ? quadrants.slice(0, 4) : [];
  const shown = (Array.isArray(points) ? points : []).filter(
    (p) => p && finite(p.x) && finite(p.y),
  );
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const percent = (v: number) => Math.round(v * 10_000) / 100;
  return (
    <div className="rk-matrix rk-frame">
      <div className="rk-matrix-y" aria-hidden="true">
        <span>{yLow}</span>
        <span>
          {yHigh}
          {yHigh ? <Arrow /> : null}
        </span>
      </div>
      <div className="rk-matrix-body">
        <div
          className="rk-matrix-plot"
          role="img"
          aria-label={describe([
            words.t("matrixAxes", { x: xHigh || "x", y: yHigh || "y" }),
            ...names.map(
              (name, i) =>
                `${words.t((["topLeft", "topRight", "bottomLeft", "bottomRight"] as const)[i]!)}: ${text(name)}`,
            ),
            ...shown.map((p) =>
              words.t("pointAt", {
                label: text(p.label),
                x: words.number(clamp(p.x), { style: "percent", maximumFractionDigits: 0 }),
                y: words.number(clamp(p.y), { style: "percent", maximumFractionDigits: 0 }),
              }),
            ),
          ])}
        >
          {names.map((name, i) => (
            <span key={i} className="rk-matrix-quadrant" data-corner={i} title={text(name)}>
              {name}
            </span>
          ))}
          {shown.map((p, i) => (
            <span
              key={`p${i}`}
              className="rk-matrix-point"
              data-flip={clamp(p.x) > 0.75 || undefined}
              style={{ left: `${percent(clamp(p.x))}%`, top: `${percent(1 - clamp(p.y))}%` }}
            >
              <span className="rk-matrix-dot" />
              <span className="rk-matrix-label" title={text(p.label)}>
                {p.label}
              </span>
            </span>
          ))}
        </div>
        <div className="rk-matrix-x" aria-hidden="true">
          <span>{xLow}</span>
          <span>
            {xHigh}
            {xHigh ? <Arrow /> : null}
          </span>
        </div>
      </div>
    </div>
  );
}

export type SourceRecord = {
  value?: unknown;
  asOf?: string;
  fresh?: boolean;
  updating?: boolean;
  error?: string;
};

const CONNECT_HINT = /^(Connect|Reconnect) .+ to see live data\.?$/;

/** When a figure was last read: "Updated 3 min ago" while live, else "As of" its snapshot date. */
export function SourceStamp({ source }: { source?: SourceRecord }) {
  const words = useWords();
  const [now, setNow] = useState(() => Date.now());
  const fresh = source?.fresh === true;
  useEffect(() => {
    if (!fresh) return;
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [fresh]);
  if (!source || typeof source !== "object") return null;
  const time = typeof source.asOf === "string" ? Date.parse(source.asOf) : Number.NaN;
  const known = Number.isFinite(time);
  const when = known
    ? fresh
      ? words.t("updated", { ago: words.ago(now - time) })
      : words.t("asOf", { date: words.date(time, { dateStyle: "medium" }) })
    : "";
  const error = typeof source.error === "string" && source.error ? source.error : "";
  const pill = source.updating
    ? words.t("updating")
    : error
      ? CONNECT_HINT.test(error)
        ? error
        : words.t("refreshFailed")
      : "";
  if (!when && !pill) return null;
  return (
    <span className="rk-stamp" title={known ? new Date(time).toISOString() : undefined}>
      {when ? <span>{when}</span> : null}
      {pill ? (
        <span className="rk-stamp-pill" data-error={(!source.updating && !!error) || undefined}>
          {pill}
        </span>
      ) : null}
    </span>
  );
}

/** A calm placeholder where a chart has nothing to draw, so the page never breaks. */
export function EmptyChart() {
  const words = useWords();
  return (
    <div className="rk-chart-empty" role="img" aria-label={words.t("noDataToChart")}>
      {words.t("noData")}
    </div>
  );
}
