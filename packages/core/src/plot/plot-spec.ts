/// <reference lib="dom" />
import * as Plot from "@observablehq/plot";
import { MAX_CHART_DATA_ROWS } from "@rakazo/contracts";
import { autoType, csvParse, tsvParse } from "d3-dsv";

/**
 * Declarative, JSON-only surface over Observable Plot for the render_plot
 * agent tool. Marks and transforms are allowlisted by name; specs carry plain
 * data and options, never code, so rendering stays safe server-side.
 */

export type PlotMarkSpec = {
  type: string;
  /** Per-mark data override; falls back to the spec-level data. */
  data?: unknown[];
  /** Mark channel options: x, y, stroke, fill, fx, fy, sort, tip, … */
  options?: Record<string, unknown>;
  /** Optional transform wrapping the options, e.g. {name:"binX", outputs:{y:"count"}}. */
  transform?: { name: string; outputs?: Record<string, unknown> };
};

export type PlotSpec = {
  title?: string;
  /** Rows may also arrive nested in the spec; treated like top-level data. */
  data?: unknown[];
  width?: number;
  height?: number;
  marginLeft?: number;
  marginRight?: number;
  marginTop?: number;
  marginBottom?: number;
  grid?: boolean;
  inset?: number;
  aspectRatio?: number;
  x?: Record<string, unknown>;
  y?: Record<string, unknown>;
  fx?: Record<string, unknown>;
  fy?: Record<string, unknown>;
  facet?: Record<string, unknown>;
  color?: Record<string, unknown>;
  r?: Record<string, unknown>;
  opacity?: Record<string, unknown>;
  symbol?: Record<string, unknown>;
  length?: Record<string, unknown>;
  projection?: unknown;
  style?: Record<string, unknown>;
  marks: PlotMarkSpec[];
};

type MarkFactory = (data: unknown, options: Record<string, unknown>) => Plot.Markish;

const DATA_MARKS = {
  area: Plot.area,
  areaX: Plot.areaX,
  areaY: Plot.areaY,
  arrow: Plot.arrow,
  barX: Plot.barX,
  barY: Plot.barY,
  boxX: Plot.boxX,
  boxY: Plot.boxY,
  cell: Plot.cell,
  cellX: Plot.cellX,
  cellY: Plot.cellY,
  circle: Plot.circle,
  cluster: Plot.cluster,
  contour: Plot.contour as unknown as MarkFactory,
  delaunayLink: Plot.delaunayLink,
  delaunayMesh: Plot.delaunayMesh,
  density: Plot.density,
  dot: Plot.dot,
  dotX: Plot.dotX,
  dotY: Plot.dotY,
  hull: Plot.hull,
  line: Plot.line,
  lineX: Plot.lineX,
  lineY: Plot.lineY,
  linearRegressionX: Plot.linearRegressionX,
  linearRegressionY: Plot.linearRegressionY,
  link: Plot.link,
  raster: Plot.raster as unknown as MarkFactory,
  rect: Plot.rect,
  rectX: Plot.rectX,
  rectY: Plot.rectY,
  ruleX: Plot.ruleX,
  ruleY: Plot.ruleY,
  spike: Plot.spike,
  text: Plot.text,
  textX: Plot.textX,
  textY: Plot.textY,
  tickX: Plot.tickX,
  tickY: Plot.tickY,
  tree: Plot.tree,
  vector: Plot.vector,
  vectorX: Plot.vectorX,
  vectorY: Plot.vectorY,
  voronoi: Plot.voronoi,
  voronoiMesh: Plot.voronoiMesh,
  waffleX: Plot.waffleX,
  waffleY: Plot.waffleY,
} as unknown as Record<string, MarkFactory>;

const DATALESS_MARKS = {
  axisX: Plot.axisX,
  axisY: Plot.axisY,
  frame: Plot.frame,
  gridX: Plot.gridX,
  gridY: Plot.gridY,
  hexgrid: Plot.hexgrid,
  sphere: Plot.sphere,
  graticule: Plot.graticule,
} as unknown as Record<string, (options: Record<string, unknown>) => Plot.Markish>;

type TransformFactory = (
  outputs: Record<string, unknown>,
  options: Record<string, unknown>,
) => Record<string, unknown>;

const TRANSFORMS = {
  bin: Plot.bin,
  binX: Plot.binX,
  binY: Plot.binY,
  group: Plot.group,
  groupX: Plot.groupX,
  groupY: Plot.groupY,
  groupZ: Plot.groupZ,
  hexbin: Plot.hexbin,
  normalizeX: Plot.normalizeX,
  normalizeY: Plot.normalizeY,
  windowX: Plot.windowX,
  windowY: Plot.windowY,
  stackX: Plot.stackX,
  stackY: Plot.stackY,
  dodgeX: Plot.dodgeX,
  dodgeY: Plot.dodgeY,
  shiftX: Plot.shiftX,
  select: Plot.select,
} as unknown as Record<string, TransformFactory>;

export function supportedPlotNames(): { marks: string[]; transforms: string[] } {
  return {
    marks: [...Object.keys(DATA_MARKS), ...Object.keys(DATALESS_MARKS)].sort(),
    transforms: Object.keys(TRANSFORMS).sort(),
  };
}

/** Bound all row arrays carried by a plot, including per-mark overrides. */
export function assertPlotDataWithinLimits(spec: PlotSpec, data: unknown[] | undefined): void {
  const marks = Array.isArray(spec.marks) ? spec.marks : [];
  const sources = [data, spec.data, ...marks.map((mark) => mark.data)].filter(
    (rows): rows is unknown[] => Array.isArray(rows),
  );
  const rowCount = sources.reduce((total, rows) => total + rows.length, 0);
  if (rowCount > MAX_CHART_DATA_ROWS) {
    throw new Error(
      `Plot data exceeds the ${MAX_CHART_DATA_ROWS.toLocaleString("en-US")}-row limit across top-level, spec, and mark data.`,
    );
  }
}

// Channels where a string must name a column; a typo otherwise renders an
// empty chart with no error, which strands the calling model.
const COLUMN_CHANNELS = ["x", "y", "x1", "x2", "y1", "y2", "fx", "fy"] as const;

function assertChannelsMatchColumns(mark: PlotMarkSpec, data: unknown[]): void {
  const first = data[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return;
  const keys = Object.keys(first);
  const available = new Set(keys);
  let namedChannels = 0;
  for (const channel of COLUMN_CHANNELS) {
    const value = mark.options?.[channel];
    if (value !== undefined) namedChannels += 1;
    if (typeof value === "string" && !available.has(value)) {
      throw new Error(
        `Mark "${mark.type}": ${channel} refers to "${value}" but the data columns are: ${keys.join(", ")}. Channel names must match data keys exactly.`,
      );
    }
  }
  if (namedChannels === 0 && !mark.transform) {
    throw new Error(
      `Mark "${mark.type}" has object rows but no position channels; set options like {"x": "<column>", "y": "<column>"} using these columns: ${keys.join(", ")}.`,
    );
  }
}

/** Models also hand over data as CSV text lines; parse those into rows. */
function normalizeRows(rows: unknown[]): unknown[] {
  if (
    rows.length > 1 &&
    rows.every((row) => typeof row === "string") &&
    (rows[0] as string).includes(",")
  ) {
    return parsePlotData("data.csv", rows.join("\n"));
  }
  return coerceNumericStrings(rows);
}

/** Models often send numbers as JSON strings; ordinal-typed values then stack
    into one giant bar instead of measuring. Coerce numeric-looking strings. */
function coerceNumericStrings(rows: unknown[]): unknown[] {
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = typeof value === "string" && isPlainNumber(value) ? Number(value) : value;
    }
    return out;
  });
}

function isPlainNumber(value: string): boolean {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  return trimmed !== "" && Number.isFinite(parsed) && String(parsed) === trimmed;
}

function buildMark(
  mark: PlotMarkSpec,
  sharedData: unknown[] | undefined,
  normalizeData: (rows: unknown[]) => unknown[],
): Plot.Markish {
  const options = { ...(mark.options ?? {}) };
  const dataless = DATALESS_MARKS[mark.type];
  if (dataless) return dataless(options);
  const factory = DATA_MARKS[mark.type];
  if (!factory) {
    throw new Error(
      `Unsupported mark type "${mark.type}". Supported marks: ${supportedPlotNames().marks.join(", ")}`,
    );
  }
  const rawData = mark.data ?? sharedData;
  if (!rawData) throw new Error(`Mark "${mark.type}" has no data and the spec has no shared data.`);
  if (Array.isArray(rawData) && rawData.length === 0) {
    throw new Error(`Mark "${mark.type}" received an empty data array; pass the rows in "data".`);
  }
  const data = normalizeData(rawData);
  assertChannelsMatchColumns(mark, data);
  let finalOptions: Record<string, unknown> = options;
  if (mark.transform) {
    const transform = TRANSFORMS[mark.transform.name];
    if (!transform) {
      throw new Error(
        `Unsupported transform "${mark.transform.name}". Supported transforms: ${supportedPlotNames().transforms.join(", ")}`,
      );
    }
    const outputs = mark.transform.outputs ?? {};
    // normalize* takes a bare basis value ("sum", "extent", …), not an outputs object.
    const first = mark.transform.name.startsWith("normalize")
      ? ((outputs as { basis?: unknown }).basis ?? "sum")
      : outputs;
    finalOptions = transform(first as Record<string, unknown>, options);
  }
  return factory(data, finalOptions);
}

export function parsePlotData(name: string, content: string): unknown[] {
  if (/\.csv$/i.test(name)) return csvParse(content, autoType);
  if (/\.tsv$/i.test(name)) return tsvParse(content, autoType);
  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed))
    throw new Error("JSON data files must contain a top-level array of rows");
  return parsed;
}

const XMLNS = "http://www.w3.org/2000/xmlns/";

function isSafePlotLink(href: string): boolean {
  try {
    // Use the URL parser's control-character and scheme handling. The fixed
    // base allows relative links even in the server's about:blank document;
    // retain the original attribute so clients resolve it against their page.
    const { protocol } = new URL(href, "https://plot.invalid/");
    return ["http:", "https:", "mailto:", "tel:"].includes(protocol);
  } catch {
    return false;
  }
}

function sanitizePlotLinks(plotted: Element): void {
  // Inspect the resolved output: href can come from columns, per-mark arrays,
  // channel objects, scales, or transforms. Check both href and xlink:href
  // before either mounting the live plot or serializing it for export.
  for (const anchor of Array.from(plotted.querySelectorAll("a"))) {
    for (const attribute of Array.from(anchor.attributes)) {
      if (attribute.localName === "href" && !isSafePlotLink(attribute.value)) {
        anchor.removeAttributeNode(attribute);
      }
    }
  }
}

export type PlotParts = {
  /** The rendered element (an <svg>, or a <figure> wrapping one). */
  plotted: Element;
  /** The plot's own <svg>, for serialization. */
  svg: Element;
  title?: string;
  swatches: { label: string; color: string }[];
  width: number;
  height: number;
};

/**
 * Build the rendered plot element plus title and categorical legend metadata.
 * Shared by the server (which composes a standalone SVG for PNG export) and
 * the browser (which mounts the element live and draws title/legend as HTML).
 */
export function buildPlotParts(
  spec: PlotSpec,
  data: unknown[] | undefined,
  document: Document,
  overrides: { width?: number; height?: number } = {},
): PlotParts {
  if (!Array.isArray(spec.marks) || spec.marks.length === 0) {
    throw new Error("The spec needs a non-empty marks array.");
  }
  assertPlotDataWithinLimits(spec, data);
  const { title, marks, data: nestedData, ...plotOptions } = spec;
  const sharedData = data ?? (Array.isArray(nestedData) ? nestedData : undefined);
  const normalizedData = new WeakMap<unknown[], unknown[]>();
  const normalizeData = (rows: unknown[]) => {
    const cached = normalizedData.get(rows);
    if (cached) return cached;
    const normalized = normalizeRows(rows);
    normalizedData.set(rows, normalized);
    return normalized;
  };
  const sanitizedPlotOptions = { ...plotOptions } as Record<string, unknown>;
  for (const scale of ["color", "x", "y", "fx", "fy", "r", "opacity", "symbol"] as const) {
    const options = sanitizedPlotOptions[scale];
    // Plot renders legends/titles as HTML <figure> wrappers, which cannot
    // rasterize to a standalone image; title and swatches are composed by the
    // caller instead.
    if (options && typeof options === "object") {
      const scaleOptions = { ...(options as Record<string, unknown>) };
      delete scaleOptions.legend;
      sanitizedPlotOptions[scale] = scaleOptions;
    }
  }
  const plotted = Plot.plot({
    document,
    ...(sanitizedPlotOptions as Plot.PlotOptions),
    ...(overrides.width ? { width: overrides.width } : {}),
    ...(overrides.height ? { height: overrides.height } : {}),
    marks: marks.map((mark) => buildMark(mark, sharedData, normalizeData)),
  });
  sanitizePlotLinks(plotted);
  const svg = plotted.tagName === "svg" ? plotted : plotted.querySelector("svg");
  if (!svg) throw new Error("Plot did not produce an SVG element");
  const width = Number(svg.getAttribute("width") ?? overrides.width ?? spec.width ?? 640);
  const height = Number(svg.getAttribute("height") ?? overrides.height ?? spec.height ?? 400);
  const colorScale = (
    plotted as unknown as { scale?: (name: string) => Plot.Scale | undefined }
  ).scale?.("color");
  return { plotted, svg, title, swatches: categoricalSwatches(colorScale), width, height };
}

/** Render a spec to a standalone SVG string using the provided DOM document. */
export function renderPlotSpecToSvg(
  spec: PlotSpec,
  data: unknown[] | undefined,
  document: Document,
): string {
  const { svg, title, swatches, width, height } = buildPlotParts(spec, data, document);
  const titleHeight = title ? 28 : 0;
  const legendHeight = swatches.length > 0 ? 24 : 0;
  const totalHeight = height + titleHeight + legendHeight;

  svg.setAttributeNS(XMLNS, "xmlns", "http://www.w3.org/2000/svg");
  svg.setAttributeNS(XMLNS, "xmlns:xlink", "http://www.w3.org/1999/xlink");
  svg.setAttribute("y", String(titleHeight + legendHeight));
  const header: string[] = [];
  if (title) {
    header.push(
      `<text x="8" y="19" font-family="system-ui, sans-serif" font-size="15" font-weight="600" fill="currentColor">${escapeXml(title)}</text>`,
    );
  }
  let swatchX = 8;
  for (const { label, color } of swatches) {
    header.push(
      `<rect x="${swatchX}" y="${titleHeight + 5}" width="11" height="11" fill="${escapeXml(color)}"></rect>`,
      `<text x="${swatchX + 15}" y="${titleHeight + 15}" font-family="system-ui, sans-serif" font-size="12" fill="currentColor">${escapeXml(label)}</text>`,
    );
    swatchX += 15 + 8 + label.length * 7 + 14;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}" font-family="system-ui, sans-serif" style="background:#ffffff;color:#1a1a1a">${header.join("")}${svg.outerHTML}</svg>`;
}

function categoricalSwatches(scale: Plot.Scale | undefined): { label: string; color: string }[] {
  if (!scale || typeof scale.apply !== "function") return [];
  const domain = Array.isArray(scale.domain) ? scale.domain : [];
  if (domain.length === 0 || domain.length > 12) return [];
  if (scale.type && scale.type !== "ordinal" && scale.type !== "categorical") return [];
  return domain.map((value) => ({
    label: String(value),
    color: String(scale.apply(value)),
  }));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export type ChartCatalogEntry = {
  name: string;
  when: string;
  keywords: string;
  /** Complete runnable example: substitute your own rows and column names. */
  spec: PlotSpec;
};

const SALES = [
  { quarter: "Q1", region: "east", sales: 120 },
  { quarter: "Q2", region: "east", sales: 185 },
  { quarter: "Q3", region: "east", sales: 143 },
  { quarter: "Q4", region: "east", sales: 210 },
  { quarter: "Q1", region: "west", sales: 90 },
  { quarter: "Q2", region: "west", sales: 132 },
  { quarter: "Q3", region: "west", sales: 166 },
  { quarter: "Q4", region: "west", sales: 158 },
];

const MEASURES = [
  { size: 4.2, weight: 31, kind: "a" },
  { size: 5.1, weight: 42, kind: "a" },
  { size: 6.3, weight: 51, kind: "b" },
  { size: 4.8, weight: 36, kind: "b" },
  { size: 5.9, weight: 48, kind: "a" },
  { size: 6.8, weight: 57, kind: "b" },
  { size: 5.4, weight: 44, kind: "a" },
  { size: 4.5, weight: 33, kind: "b" },
];

export const CHART_CATALOG: ChartCatalogEntry[] = [
  {
    name: "bar",
    when: "Compare one value across categories",
    keywords: "bar column comparison rank vendor category",
    spec: {
      title: "Sales by quarter",
      data: SALES.slice(0, 4),
      marks: [{ type: "barY", options: { x: "quarter", y: "sales" } }],
    },
  },
  {
    name: "horizontal bar",
    when: "Compare categories with long names, sorted by value",
    keywords: "bar horizontal rank sorted top",
    spec: {
      title: "Sales by quarter",
      data: SALES.slice(0, 4),
      marginLeft: 60,
      marks: [{ type: "barX", options: { y: "quarter", x: "sales", sort: { y: "-x" } } }],
    },
  },
  {
    name: "stacked bar",
    when: "Category totals split by a sub-category",
    keywords: "stacked composition part-of-whole share breakdown",
    spec: {
      title: "Sales by quarter and region",
      data: SALES,
      marks: [{ type: "barY", options: { x: "quarter", y: "sales", fill: "region" } }],
    },
  },
  {
    name: "grouped bar",
    when: "Compare sub-categories side by side within groups",
    keywords: "grouped side-by-side clustered",
    spec: {
      title: "Sales by region per quarter",
      data: SALES,
      marks: [
        { type: "barY", options: { fx: "quarter", x: "region", y: "sales", fill: "region" } },
      ],
    },
  },
  {
    name: "normalized bar",
    when: "Compare percentage shares across categories",
    keywords: "percent share normalized 100%",
    spec: {
      title: "Regional share per quarter",
      data: SALES,
      y: { percent: true },
      marks: [
        {
          type: "barY",
          transform: { name: "normalizeY", outputs: { basis: "sum" } },
          options: { x: "quarter", y: "sales", fill: "region" },
        },
      ],
    },
  },
  {
    name: "histogram",
    when: "Distribution of one numeric column",
    keywords: "histogram distribution frequency bins spread",
    spec: {
      title: "Weight distribution",
      data: MEASURES,
      marks: [
        {
          type: "rectY",
          transform: { name: "binX", outputs: { y: "count" } },
          options: { x: "weight" },
        },
        { type: "ruleY", data: [0] },
      ],
    },
  },
  {
    name: "scatter",
    when: "Relationship between two numeric columns",
    keywords: "scatter correlation relationship points xy",
    spec: {
      title: "Weight vs size",
      data: MEASURES,
      grid: true,
      marks: [{ type: "dot", options: { x: "size", y: "weight", stroke: "kind" } }],
    },
  },
  {
    name: "scatter with trend",
    when: "Relationship plus a linear trend line",
    keywords: "regression trend fit correlation",
    spec: {
      title: "Weight vs size with trend",
      data: MEASURES,
      marks: [
        { type: "dot", options: { x: "size", y: "weight" } },
        { type: "linearRegressionY", options: { x: "size", y: "weight", stroke: "red" } },
      ],
    },
  },
  {
    name: "bubble",
    when: "Scatter with a third value shown as dot size",
    keywords: "bubble size magnitude three variables",
    spec: {
      title: "Sized by weight",
      data: MEASURES,
      marks: [
        {
          type: "dot",
          options: { x: "size", y: "weight", r: "weight", fill: "kind", fillOpacity: 0.6 },
        },
      ],
    },
  },
  {
    name: "line",
    when: "A value changing over an ordered axis (time)",
    keywords: "line time series trend over-time",
    spec: {
      title: "Sales over quarters",
      data: SALES.slice(0, 4),
      marks: [
        { type: "lineY", options: { x: "quarter", y: "sales" } },
        { type: "dot", options: { x: "quarter", y: "sales" } },
      ],
    },
  },
  {
    name: "multi line",
    when: "One line per category over time",
    keywords: "multi-series lines compare trends",
    spec: {
      title: "Sales by region",
      data: SALES,
      marks: [{ type: "lineY", options: { x: "quarter", y: "sales", stroke: "region" } }],
    },
  },
  {
    name: "area",
    when: "Magnitude over time with filled area",
    keywords: "area filled volume cumulative",
    spec: {
      title: "Sales area",
      data: SALES.slice(0, 4),
      marks: [
        { type: "areaY", options: { x: "quarter", y: "sales", fillOpacity: 0.4 } },
        { type: "lineY", options: { x: "quarter", y: "sales" } },
      ],
    },
  },
  {
    name: "stacked area",
    when: "Composition over time",
    keywords: "stacked area composition over-time streamgraph",
    spec: {
      title: "Sales composition",
      data: SALES,
      marks: [{ type: "areaY", options: { x: "quarter", y: "sales", fill: "region" } }],
    },
  },
  {
    name: "heatmap",
    when: "A value across two categorical axes",
    keywords: "heatmap matrix grid cells intensity",
    spec: {
      title: "Sales heat",
      data: SALES,
      marks: [{ type: "cell", options: { x: "quarter", y: "region", fill: "sales" } }],
    },
  },
  {
    name: "box plot",
    when: "Distribution summary per category",
    keywords: "box whisker quartile median outliers",
    spec: {
      title: "Weight by kind",
      data: MEASURES,
      marks: [{ type: "boxY", options: { x: "kind", y: "weight" } }],
    },
  },
  {
    name: "strip plot",
    when: "Raw value ticks per category",
    keywords: "strip ticks raw values jitter",
    spec: {
      title: "Weights by kind",
      data: MEASURES,
      marks: [{ type: "tickX", options: { x: "weight", y: "kind" } }],
    },
  },
  {
    name: "waffle",
    when: "Part-of-whole as counted squares (pie-chart alternative)",
    keywords: "waffle pie donut share proportion",
    spec: {
      title: "Sales share",
      data: SALES.slice(0, 4),
      marks: [{ type: "waffleY", options: { x: "quarter", y: "sales", fill: "quarter" } }],
    },
  },
  {
    name: "small multiples",
    when: "Same chart repeated per category",
    keywords: "facets small-multiples panels grid per-category",
    spec: {
      title: "Per-region panels",
      data: SALES,
      marks: [{ type: "barY", options: { x: "quarter", y: "sales", fx: "region" } }],
    },
  },
  {
    name: "moving average",
    when: "Smooth a noisy series",
    keywords: "rolling moving average smooth window",
    spec: {
      title: "Smoothed sales",
      data: SALES,
      marks: [
        { type: "lineY", options: { x: "quarter", y: "sales", stroke: "#bbb" } },
        {
          type: "lineY",
          transform: { name: "windowY", outputs: { k: 3, reduce: "mean" } },
          options: { x: "quarter", y: "sales" },
        },
      ],
    },
  },
  {
    name: "annotated",
    when: "Any chart plus reference lines and labels",
    keywords: "annotation reference threshold target label",
    spec: {
      title: "Sales vs target",
      data: SALES.slice(0, 4),
      marks: [
        { type: "barY", options: { x: "quarter", y: "sales" } },
        { type: "ruleY", data: [150], options: { stroke: "red" } },
        {
          type: "text",
          data: [{ quarter: "Q1", sales: 160 }],
          options: { x: "quarter", y: "sales", text: ["target 150"], fill: "red" },
        },
      ],
    },
  },
];

export function searchChartCatalog(query?: string): ChartCatalogEntry[] {
  if (!query || typeof query !== "string") return CHART_CATALOG;
  const needles = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = CHART_CATALOG.filter((entry) => {
    const haystack = `${entry.name} ${entry.when} ${entry.keywords}`.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  });
  return matches.length > 0 ? matches : CHART_CATALOG;
}

export const PLOT_TOOL_GUIDE = `# render_plot — deep data visualization skill

You can produce publication-quality charts with the render_plot tool, backed by
Observable Plot (the grammar behind the Observable Plot gallery). You describe
the chart as a JSON spec; the tool renders it to a PNG in your workspace and
attaches it to the chat.

## How to use the tool

1. Get or shape the data: an array of row objects. Either pass it inline as
   "data", or write it to a .csv/.tsv/.json file in your home and pass
   "data_path". CSV/TSV columns are auto-typed (numbers and dates are parsed).
2. Choose the chart form for the question. Call render_plot with
   {"charts": true} to list every chart type with a complete runnable example
   spec, or {"charts": "distribution"} to search by keyword. Copy the closest
   example and substitute your rows and column names.
3. Call render_plot with {"spec": {...}, "data": [...]} or
   {"spec": {...}, "data_path": "sales.csv"}.
4. The tool attaches the PNG to the chat automatically (attach: false to skip)
   and returns the output path, for example charts/plot-1.png.
5. Iterate: adjust marks, scales, and facets until the chart answers the
   question. Prefer several small focused charts over one crowded chart.

## Spec format

{
  "title": "optional chart title",
  "width": 640, "height": 400,
  "grid": true,
  "x": {"label": "…", "type": "log|linear|utc|band|point", "domain": […]},
  "y": {…}, "color": {"scheme": "tableau10|blues|turbo|…", "type": "diverging"},
  "fx": {…}, "fy": {…},                    // facet scales
  "marks": [
    {"type": "dot", "options": {"x": "field", "y": "field", "stroke": "category", "tip": true}},
    {"type": "ruleY", "data": [0]}         // per-mark data for annotations
  ]
}

Channel values are column names ("x": "price"), constants ("fill": "#4269d0"),
or for faceting put "fx"/"fy" in a mark's options. Add "sort": {"x": "-y"} to
order categories by value. Transforms wrap a mark's options:

  {"type": "rectY", "transform": {"name": "binX", "outputs": {"y": "count"}},
   "options": {"x": "weight", "fill": "species"}}

## Chart catalog (from the Plot gallery)

- Bar chart: barY + {"x": category, "y": value}; horizontal: barX with y category.
- Grouped / stacked bars: add "fill": category (stacks automatically);
  grouped: use "fx": category with barY.
- Histogram: rectY + transform binX with outputs {"y": "count"}.
- 2D histogram / heatmap: rect + transform bin with outputs {"fill": "count"};
  categorical heatmap: cell + {"x", "y", "fill": value}.
- Hex density: dot with transform hexbin, outputs {"r": "count"} or {"fill": "count"}.
- Scatterplot: dot + {"x", "y"}; bubble: add "r": value; add
  linearRegressionY for a trend line.
- Line chart: lineY + {"x": time, "y": value}; multi-series: add "stroke": category.
- Moving average: lineY + transform windowY; the window settings go in the
  transform outputs, e.g. {"name": "windowY", "outputs": {"k": 7, "reduce": "mean"}}.
- Area / streamgraph: areaY + {"x", "y", "fill": category} (+ "offset": "wiggle"
  in the y scale for streamgraphs).
- Box plot: boxY + {"x": category, "y": value}.
- Distribution ticks / strip plot: tickX + {"x": value, "y": category}.
- Slope / bump styles: line + point marks combined.
- Normalized shares: barY with transform normalizeY, or y scale {"percent": true}.
- Small multiples: any mark + "fx"/"fy" in its options (one panel per category).
- Candlestick-style ranges: ruleX with {"x", "y1", "y2"}.
- Tree / hierarchy: tree mark with path data like ["a/b/c", …].
- Network / flows: arrow or link marks with {"x1","y1","x2","y2"}.
- Contours / density: density for 2D point density, contour for gridded values.
- Waffle chart: waffleY + {"y": value, "fill": category}.
- Annotations: text marks for labels, ruleX/ruleY with per-mark "data" for
  reference lines, frame for panel borders.
- Maps: projection option (e.g. "equal-earth") with geo-ready coordinates on
  dot/spike/vector marks; sphere and graticule marks for context.

## Design rules

- Always label: set x/y {"label": …} when column names are cryptic; add a title.
- "tip": true on the primary mark documents exact values in the SVG structure.
- Use color only when it encodes something; categorical legends render
  automatically for up to 12 categories.
- Continuous color scales render without a legend bar — encode the scale
  meaning in the title or caption text instead.
- Sort categorical axes by value ("sort": {"x": "-y"}) unless order is inherent.
- Prefer binning/aggregation transforms over plotting tens of thousands of raw
  points; raw dots beyond ~5k rows get slow and unreadable.

Call render_plot with {"help": true} anytime to reread this guide.
`;
