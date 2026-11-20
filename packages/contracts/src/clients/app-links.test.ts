import { describe, expect, it } from "vitest";
import { appLinkUrl } from "./app-links.js";

describe("app links", () => {
  it("allows a link that opens a note", () => {
    expect(appLinkUrl("obsidian://open?vault=Notes&file=Plans%2FPrep")).toBe(
      "obsidian://open?vault=Notes&file=Plans%2FPrep",
    );
    expect(appLinkUrl("  OBSIDIAN://open?vault=Notes")).toBe("obsidian://open?vault=Notes");
    expect(appLinkUrl("obsidian://open")).toBe("obsidian://open");
  });

  it("refuses actions that write files or reach plugins", () => {
    expect(appLinkUrl("obsidian://new?vault=Notes&name=Prep&content=x")).toBeUndefined();
    expect(appLinkUrl("obsidian://daily?vault=Notes&append=true")).toBeUndefined();
    expect(appLinkUrl("obsidian://advanced-uri?commandid=x")).toBeUndefined();
    expect(appLinkUrl("obsidian://OPEN?vault=Notes")).toBeUndefined();
  });

  it("refuses other parameters and URL parts on the open action", () => {
    expect(appLinkUrl("obsidian://open?path=%2Fetc")).toBeUndefined();
    expect(appLinkUrl("obsidian://open?vault=Notes&overwrite=true")).toBeUndefined();
    expect(appLinkUrl("obsidian://open/../new?vault=Notes")).toBeUndefined();
    expect(appLinkUrl("obsidian://user@open?vault=Notes")).toBeUndefined();
    expect(appLinkUrl("obsidian://open:1?vault=Notes")).toBeUndefined();
    expect(appLinkUrl("obsidian://open?vault=Notes#x")).toBeUndefined();
  });

  it("refuses web, script and unlisted app schemes", () => {
    expect(appLinkUrl("https://example.com")).toBeUndefined();
    expect(appLinkUrl("javascript:alert(1)")).toBeUndefined();
    expect(appLinkUrl("file:///etc/passwd")).toBeUndefined();
    expect(appLinkUrl("vscode://file/etc/passwd")).toBeUndefined();
    expect(appLinkUrl("obsidian-like://open")).toBeUndefined();
    expect(appLinkUrl("/relative/obsidian://open")).toBeUndefined();
  });
});
