import { describe, expect, it } from "vitest";
import { searchHitPreview, searchHitRowPreview } from "./search-list.js";

describe("searchHitPreview", () => {
  it("strips markdown to a plain line", () => {
    expect(searchHitPreview("# Status\n- see [the report](https://example.com)")).toBe(
      "Status see the report",
    );
    expect(searchHitPreview("The inbox is **completely empty**.")).toBe(
      "The inbox is completely empty.",
    );
  });

  it("drops data-URI image text, including a snippet cut off mid-URI", () => {
    expect(
      searchHitPreview("Before ![shot](data:image/png;base64,iVBORw0KGgoAAAANSUhEUg) after"),
    ).toBe("Before shot after");
    expect(searchHitPreview("Before ![shot](data:image/png;base64,iVBORw0KGgoAAAANSUhEUg")).toBe(
      "Before",
    );
    expect(searchHitPreview("look data:image/png;base64,iVBORw0KGgo here")).toBe("look here");
    expect(searchHitPreview("note data:;base64,SGVsbG8= next")).toBe("note next");
    expect(searchHitPreview("note data:,hello next")).toBe("note next");
    expect(searchHitPreview("see data:image/png next")).toBe("see data:image/png next");
    expect(searchHitPreview("keep metadata: label")).toBe("keep metadata: label");
  });

  it("joins the conversation name with the plain preview", () => {
    expect(
      searchHitRowPreview({
        botName: "Scout",
        snippet: "See **this** ![x](data:image/png;base64,aaaa)",
      }),
    ).toBe("Scout: See this x");
  });
});
