import { describe, expect, it } from "vitest";
import { ThreadJumpAnchor } from "./thread-jump.js";

describe("ThreadJumpAnchor", () => {
  it("scrolls to the matched message and ignores a provisional zero from a later row", () => {
    const anchor = new ThreadJumpAnchor();
    anchor.begin("message-4");

    expect(anchor.onMessageLayout("message-4", 0, 3, 120)).toBeNull();
    expect(anchor.holds()).toBe(true);
    expect(anchor.onMessageLayout("message-4", 640, 3, 120)).toBe(520);
    expect(anchor.align(140)).toBe(500);
  });

  it("accepts the top of the page when the match is the first row", () => {
    const anchor = new ThreadJumpAnchor();
    anchor.begin("message-1");

    expect(anchor.onMessageLayout("message-1", 0, 0, 24)).toBe(0);
  });

  it("stops reapplying once the reader takes over", () => {
    const anchor = new ThreadJumpAnchor();
    anchor.begin("message-4");
    anchor.onMessageLayout("message-4", 640, 3, 120);

    anchor.release();
    expect(anchor.holds()).toBe(false);
    expect(anchor.align(120)).toBeNull();
    expect(anchor.onMessageLayout("message-4", 800, 3, 120)).toBeNull();
  });

  it("blocks paging only while a drawn match has no offset", () => {
    const anchor = new ThreadJumpAnchor();
    anchor.begin("message-4");

    expect(anchor.blocksPaging(true, 120)).toBe(true);
    expect(anchor.blocksPaging(false, 120)).toBe(false);

    anchor.onMessageLayout("message-4", 640, 3, 120);
    expect(anchor.blocksPaging(true, 120)).toBe(false);
  });

  it("does not hold a thread opened with no message", () => {
    const anchor = new ThreadJumpAnchor();
    anchor.begin(null);
    expect(anchor.holds()).toBe(false);
    expect(anchor.onMessageLayout("message-1", 400, 1, 120)).toBeNull();
  });
});
