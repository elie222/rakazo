// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findTextRanges } from "./chat-find";

function transcript(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("findTextRanges", () => {
  it("finds every match across messages, ignoring case", () => {
    const root = transcript("<p>Deploy the <b>deploy</b> script</p><p>DEPLOYED and redeploy</p>");
    const found = findTextRanges(root, "deploy").map((range) => range.toString());
    expect(found).toEqual(["Deploy", "deploy", "DEPLOY", "deploy"]);
  });

  it("does not count overlapping matches twice", () => {
    expect(findTextRanges(transcript("aaaa"), "aa")).toHaveLength(2);
  });

  it("finds nothing for an empty or blank query", () => {
    const root = transcript("<p>hello</p>");
    expect(findTextRanges(root, "")).toEqual([]);
    expect(findTextRanges(root, "  ")).toEqual([]);
  });
});
