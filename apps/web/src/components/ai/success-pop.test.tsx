import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SuccessPop } from "./primitives";

const pop = "motion-safe:animate-[bui-pop-in_300ms_cubic-bezier(0.23,1,0.32,1)_both]";
const fadeUp = "motion-safe:animate-[bui-fade-up_350ms_cubic-bezier(0.23,1,0.32,1)_100ms_both]";

describe("SuccessPop", () => {
  it("announces its label politely from the root status region", () => {
    const html = renderToString(<SuccessPop label="Saved" />);
    const rootTag = html.slice(0, html.indexOf(">") + 1);

    expect(rootTag).toContain('role="status"');
    expect(html).toContain("Saved");
  });

  it("runs the pop-in check and the fade-up label only under motion-safe", () => {
    const html = renderToString(<SuccessPop label="Saved" />);
    const check = html.match(/<span class="[^"]*bui-pop-in[^"]*"/)?.[0];
    const label = html.match(/<span class="[^"]*bui-fade-up[^"]*"/)?.[0];

    expect(check).toContain(pop);
    expect(label).toContain(fadeUp);
    expect(html.match(/animate-\[/g)).toHaveLength(2);
    expect(html.match(/motion-safe:animate-\[/g)).toHaveLength(2);
  });

  it("leaves no inline animation that ignores reduced motion", () => {
    const html = renderToString(<SuccessPop label="Done" />);

    expect(html).not.toContain("style=");
    expect(html).toContain("Done");
  });
});
