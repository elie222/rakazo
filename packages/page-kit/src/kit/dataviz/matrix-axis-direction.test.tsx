import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Matrix2x2 } from "./diagrams.js";

it("keeps matrix geometry LTR and isolates label direction inside an RTL page", () => {
  const html = renderToStaticMarkup(
    <section dir="rtl" lang="he">
      <Matrix2x2
        axes={{ x: ["מאמץ נמוך", "מאמץ גבוה"], y: ["השפעה נמוכה", "השפעה גבוהה"] }}
        quadrants={["מהיר", "חשוב", "משני", "מורכב"]}
        points={[
          { label: "תכנון", x: 0.2, y: 0.25 },
          { label: "מחקר", x: 0.9, y: 0.8 },
        ]}
      />
    </section>,
  );

  expect(html).toContain('<section dir="rtl" lang="he"><div class="rk-matrix rk-frame" dir="ltr">');
  expect(html).toContain('<span dir="auto">מאמץ נמוך</span>');
  expect(html).toContain('<span dir="auto">השפעה נמוכה</span>');
  expect(html).toContain('<bdi>מאמץ גבוה</bdi><svg class="rk-axis-arrow"');
  expect(html).toContain('<bdi>השפעה גבוהה</bdi><svg class="rk-axis-arrow"');
  expect(html.match(/class="rk-matrix-quadrant" dir="auto"/g)).toHaveLength(4);
  expect(html.match(/class="rk-matrix-label" dir="auto"/g)).toHaveLength(2);
  expect(html).toContain('style="left:20%;top:75%"');
  expect(html).toContain('data-flip="true" style="left:90%;top:20%"');
});
