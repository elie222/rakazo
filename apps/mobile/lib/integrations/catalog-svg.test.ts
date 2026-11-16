import { expect, it } from "vitest";
import { catalogSvgXml } from "./catalog-svg";

it("removes CSS priority suffixes before native SVG lengths are parsed", () => {
  expect(
    catalogSvgXml(
      '<svg><line style="stroke-width:26.83px !important;opacity:1!important" /></svg>',
    ),
  ).toBe('<svg><line style="stroke-width:26.83px;opacity:1" /></svg>');
});

it("handles single quotes, mixed case and multiline styles", () => {
  expect(catalogSvgXml("<svg style='width: 32px !IMPORTANT;\n height: 32px !important'/>")).toBe(
    "<svg style='width: 32px;\n height: 32px'/>",
  );
});

it("preserves artwork text and unrelated attributes", () => {
  const xml =
    '<svg data-style="!important"><text>!important</text><path d="M0 0" fill="currentColor" /></svg>';
  expect(catalogSvgXml(xml)).toBe(xml);
});
