import { describe, expect, it } from "vitest";
import { SearchHitSchema, SearchQueryOutputSchema } from "./search.js";

describe("search contracts", () => {
  it("accepts bounded workspace search results", () => {
    const parsed = SearchQueryOutputSchema.parse({
      hits: [
        {
          kind: "message",
          botId: "bot-1",
          botName: "Scout",
          title: "Scout",
          snippet: "found it",
          messageId: "msg-1",
          seq: 3,
        },
      ],
    });
    expect(parsed.hits).toHaveLength(1);
    expect(SearchHitSchema.parse(parsed.hits[0]).kind).toBe("message");
  });
});
