import { describe, expect, it } from "vitest";
import { RECEIVED_FILE_MAX_AGE_MS, receivedFilePath } from "./received-path.js";

const base = {
  at: new Date("2026-11-17T17:12:00Z"),
  timeZone: "Asia/Jerusalem",
  sender: "972541234567",
  name: "clip",
  mimeType: "video/quicktime",
  computerMode: "team" as const,
  taken: () => false,
};

describe("receivedFilePath", () => {
  it("names a team file by local date, sender and name", () => {
    expect(receivedFilePath(base)).toBe(
      "shared/received/2026/11/2026-11-17_1912_972541234567_clip.mov",
    );
  });

  it("uses the private folder on a dedicated computer", () => {
    expect(receivedFilePath({ ...base, computerMode: "dedicated" })).toBe(
      "received/2026/11/2026-11-17_1912_972541234567_clip.mov",
    );
  });

  it("takes the month folder from local time across a month boundary", () => {
    expect(receivedFilePath({ ...base, at: new Date("2026-11-30T23:30:00Z") })).toBe(
      "shared/received/2026/12/2026-12-01_0130_972541234567_clip.mov",
    );
  });

  it("falls back to the media kind when the chat app gives no name", () => {
    expect(receivedFilePath({ ...base, name: undefined })).toContain("_video.mov");
    expect(receivedFilePath({ ...base, name: undefined, mimeType: "image/png" })).toContain(
      "_image.png",
    );
    expect(receivedFilePath({ ...base, name: undefined, mimeType: "audio/ogg" })).toContain(
      "_voice.ogg",
    );
    expect(receivedFilePath({ ...base, name: undefined, mimeType: "application/pdf" })).toContain(
      "_file.pdf",
    );
  });

  it("keeps a Hebrew name and does not double the extension", () => {
    const hebrew = { ...base, name: "חשבונית.pdf", mimeType: "application/pdf" };
    expect(receivedFilePath(hebrew)).toBe(
      "shared/received/2026/11/2026-11-17_1912_972541234567_חשבונית.pdf",
    );
  });

  it("removes separators, dot-dot, control characters and leading dots from the name", () => {
    const path = receivedFilePath({ ...base, name: "..\\a/b\u0000c..d\n.hidden" });
    expect(path).toBe("shared/received/2026/11/2026-11-17_1912_972541234567_abcd.hidden.mov");
    expect(receivedFilePath({ ...base, name: "..." })).toContain("_video.mov");
  });

  it("turns a path-like sender into one safe segment", () => {
    const path = receivedFilePath({ ...base, sender: "../../etc" });
    expect(path).toBe("shared/received/2026/11/2026-11-17_1912_etc_clip.mov");
    expect(receivedFilePath({ ...base, sender: "../.." })).toContain("_1912_unknown_");
  });

  it("adds -2, -3 before the extension while the path is taken", () => {
    const first = "shared/received/2026/11/2026-11-17_1912_972541234567_clip.mov";
    const taken = new Set([first, first.replace(".mov", "-2.mov")]);
    expect(receivedFilePath({ ...base, taken: (path) => taken.has(path) })).toBe(
      first.replace(".mov", "-3.mov"),
    );
  });

  it("never starts with a slash or contains dot-dot", () => {
    const path = receivedFilePath({ ...base, sender: "/..", name: "../../x" });
    expect(path.startsWith("/")).toBe(false);
    expect(path).not.toContain("..");
  });

  it("prunes after 31 days", () => {
    expect(RECEIVED_FILE_MAX_AGE_MS).toBe(31 * 24 * 60 * 60_000);
  });
});
