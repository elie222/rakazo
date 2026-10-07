import type { SearchHit } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  dedupeSearchHits,
  searchHitListKey,
  searchHitPreview,
  searchHitRowPreview,
} from "./search-list.js";

function link(url: string, messageId = "message-1"): SearchHit {
  return {
    kind: "link",
    botId: "bot-1",
    botName: "Scout",
    title: url,
    snippet: "match",
    messageId,
    seq: 4,
    url,
  };
}

describe("searchHitListKey", () => {
  it("keeps two links from the same message distinct", () => {
    const first = link("https://example.com/a");
    const second = link("https://example.com/b");
    expect(searchHitListKey(first)).not.toBe(searchHitListKey(second));
    expect(dedupeSearchHits([first, second, first])).toEqual([first, second]);
  });

  it("drops a repeated hit", () => {
    const hit = link("https://example.com/a");
    expect(dedupeSearchHits([hit, { ...hit }])).toEqual([hit]);
  });
});

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
    ).toBe("Scout · See this x");
  });
});
