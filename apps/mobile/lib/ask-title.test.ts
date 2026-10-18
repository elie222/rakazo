import { describe, expect, it } from "vitest";
import { plainAskTitle } from "./ask-title.js";

describe("plainAskTitle", () => {
  it("shows a name the card title escaped for Markdown as typed", () => {
    expect(plainAskTitle("Change the model of my\\_bot?")).toBe("Change the model of my_bot?");
  });

  it("removes the escape from every character card titles escape, and only those", () => {
    expect(plainAskTitle("\\\\ \\` \\* \\_ \\[ \\] \\< \\> \\~ \\|")).toBe("\\ ` * _ [ ] < > ~ |");
    expect(plainAskTitle("Open C:\\temp\\# now")).toBe("Open C:\\temp\\# now");
  });
});
