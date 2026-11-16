/** Native SVG lengths accept CSS units, but cannot parse the CSS priority suffix. */
export function catalogSvgXml(xml: string): string {
  return xml.replace(
    /(\sstyle\s*=\s*)(["'])(.*?)\2/gis,
    (_attribute, prefix, quote, style) =>
      `${prefix}${quote}${style.replace(/\s*!important\b/gi, "")}${quote}`,
  );
}
