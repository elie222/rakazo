import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SuccessPop } from "./primitives";

describe("SuccessPop", () => {
  it("announces its label politely from the root status region", () => {
    const html = renderToString(<SuccessPop label="Saved" />);
    const rootTag = html.slice(0, html.indexOf(">") + 1);

    expect(rootTag).toContain('role="status"');
    expect(html).toContain("Saved");
  });
});
