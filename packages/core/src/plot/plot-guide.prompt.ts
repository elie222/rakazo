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
