import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_NAME_PATTERN,
  attachmentNamingFromEnv,
  attachmentPath,
} from "./attachment-path.js";

const base = {
  at: new Date("2026-11-17T17:12:00Z"),
  timeZone: "Asia/Jerusalem",
  sender: "972541234567",
  name: "clip",
  mimeType: "video/quicktime",
  attempt: 1,
  folders: "month" as const,
};
const dir = "attachments/2026/11";
const stamp = "2026-11-17_1912_972541234567_";

describe("attachmentPath", () => {
  it("names a file by local date, sender and name", () => {
    expect(attachmentPath(base)).toBe(`${dir}/${stamp}clip.mov`);
  });

  it("follows the documented examples", () => {
    const input = {
      ...base,
      at: new Date("2026-11-18T14:49:00Z"),
      sender: "Dana",
      name: "video.mp4",
      mimeType: "video/mp4",
    };
    expect(attachmentPath(input)).toBe("attachments/2026/11/2026-11-18_1649_Dana_video.mp4");
    expect(attachmentPath({ ...input, sender: undefined })).toBe(
      "attachments/2026/11/2026-11-18_1649_video.mp4",
    );
    expect(attachmentPath({ ...input, attempt: 3 })).toBe(
      "attachments/2026/11/2026-11-18_1649_Dana_video-3.mp4",
    );
    expect(attachmentPath({ ...input, timeZone: "UTC" })).toBe(
      "attachments/2026/11/2026-11-18_1449_Dana_video.mp4",
    );
    expect(attachmentPath({ ...input, folders: "none" })).toBe(
      "attachments/2026-11-18_1649_Dana_video.mp4",
    );
  });

  it("leaves the sender out when it is empty or only unsafe characters", () => {
    expect(attachmentPath({ ...base, sender: "" })).toBe(`${dir}/2026-11-17_1912_clip.mov`);
    expect(attachmentPath({ ...base, sender: "../.." })).toBe(`${dir}/2026-11-17_1912_clip.mov`);
  });

  it("takes the month folder from local time across a month boundary", () => {
    expect(attachmentPath({ ...base, at: new Date("2026-11-30T23:30:00Z") })).toBe(
      "attachments/2026/12/2026-12-01_0130_972541234567_clip.mov",
    );
  });

  it("falls back to the media kind when the name is empty", () => {
    expect(attachmentPath({ ...base, name: "" })).toContain("_video.mov");
    expect(attachmentPath({ ...base, name: "", mimeType: "image/png" })).toContain("_image.png");
    expect(attachmentPath({ ...base, name: "", mimeType: "audio/ogg" })).toContain("_voice.ogg");
    expect(attachmentPath({ ...base, name: "", mimeType: "application/pdf" })).toContain(
      "_file.pdf",
    );
  });

  it("keeps a Hebrew name and does not double the extension", () => {
    const hebrew = { ...base, name: "חשבונית.pdf", mimeType: "application/pdf" };
    expect(attachmentPath(hebrew)).toBe(`${dir}/${stamp}חשבונית.pdf`);
  });

  it.each([
    ["IMG_1234.JPEG", "image/jpeg", "IMG_1234.jpg"],
    ["IMG_1234.jpeg", "image/jpeg", "IMG_1234.jpg"],
    ["IMG_1234.JPG", "image/jpeg", "IMG_1234.jpg"],
    ["clip.MOV", "video/quicktime", "clip.mov"],
    ["page.HTM", "text/html", "page.html"],
  ])("drops the name's own extension %s for %s in any spelling", (name, mimeType, file) => {
    expect(attachmentPath({ ...base, name, mimeType })).toBe(`${dir}/${stamp}${file}`);
  });

  it("keeps an extension that is for another type as part of the name", () => {
    expect(attachmentPath({ ...base, name: "scan.png", mimeType: "image/jpeg" })).toBe(
      `${dir}/${stamp}scan.png.jpg`,
    );
  });

  it("removes separators, dot-dot, control characters and leading dots from the name", () => {
    const path = attachmentPath({ ...base, name: "..\\a/b\u0000c..d\n.hidden" });
    // A backslash becomes `_` (Windows does not allow it); a line break and a quote become spaces.
    expect(path).toBe(`${dir}/${stamp}_abcd .hidden.mov`);
    expect(attachmentPath({ ...base, name: "..." })).toContain("_video.mov");
  });

  it("removes the lone half of an emoji split by the chat app", () => {
    const split = "😀".slice(0, 1);
    expect(attachmentPath({ ...base, name: `photo${split}` })).toBe(`${dir}/${stamp}photo.mov`);
    expect(attachmentPath({ ...base, sender: `${split}x`, name: "" })).toContain(
      "_1912_x_video.mov",
    );
  });

  it("replaces characters Windows does not allow in a name", () => {
    const pdf = { ...base, name: "Meeting 10:30.pdf", mimeType: "application/pdf" };
    expect(attachmentPath(pdf)).toBe(`${dir}/${stamp}Meeting 10_30.pdf`);
    expect(attachmentPath({ ...base, name: 'a*b?c<d>e|f"g\\h' })).toContain("_a_b_c_d_e_f g_h.mov");
  });

  it("turns a path-like sender into one safe segment", () => {
    expect(attachmentPath({ ...base, sender: "../../etc" })).toBe(
      `${dir}/2026-11-17_1912_etc_clip.mov`,
    );
  });

  it("adds -2, -3 before the extension on later attempts", () => {
    expect(attachmentPath({ ...base, attempt: 2 })).toBe(`${dir}/${stamp}clip-2.mov`);
    expect(attachmentPath({ ...base, attempt: 3 })).toBe(`${dir}/${stamp}clip-3.mov`);
  });

  it("never starts with a slash or contains dot-dot", () => {
    const path = attachmentPath({ ...base, sender: "/..", name: "../../x" });
    expect(path.startsWith("/")).toBe(false);
    expect(path).not.toContain("..");
  });

  it("never leaves a dot-dot when a trailing dot meets the extension", () => {
    const pdf = { ...base, mimeType: "application/pdf" };
    expect(attachmentPath({ ...pdf, name: "report." })).toBe(`${dir}/${stamp}report.pdf`);
    expect(attachmentPath({ ...pdf, name: "a.pdf." })).toBe(`${dir}/${stamp}a.pdf`);
    const cutOnDot = attachmentPath({ ...pdf, name: `${"x".repeat(63)}.tail` });
    expect(cutOnDot).toBe(`${dir}/${stamp}${"x".repeat(63)}.pdf`);
  });

  it("truncates by code points without splitting a surrogate pair", () => {
    const path = attachmentPath({ ...base, name: "😀".repeat(100) });
    expect(Buffer.from(path).toString()).toBe(path);
    expect(path).toMatch(/_(😀)+\.mov$/u);
    expect(new TextEncoder().encode(path.split("/").pop() ?? "").length).toBeLessThanOrEqual(255);
  });

  it("keeps the whole file name within 255 UTF-8 bytes", () => {
    for (const name of ["ש".repeat(300), "😀".repeat(300)]) {
      const sender = "ש".repeat(50);
      for (const attempt of [1, 2]) {
        const path = attachmentPath({ ...base, name, sender, attempt });
        const fileName = path.split("/").pop() ?? "";
        expect(new TextEncoder().encode(fileName).length).toBeLessThanOrEqual(255);
        expect(Buffer.from(path).toString()).toBe(path);
        expect(path.endsWith(attempt === 2 ? "-2.mov" : ".mov")).toBe(true);
      }
    }
  });

  it("removes bidi and invisible format characters and normalizes to NFC", () => {
    expect(attachmentPath({ ...base, name: "a‮b​c⁦d e" })).toBe(`${dir}/${stamp}abcd e.mov`);
    expect(attachmentPath({ ...base, name: "é" })).toContain("_é.mov");
  });

  it("produces a name the date pattern recognizes", () => {
    const file = attachmentPath(base).split("/").pop() ?? "";
    expect(ATTACHMENT_NAME_PATTERN.test(file)).toBe(true);
    expect(ATTACHMENT_NAME_PATTERN.test("clip.mov")).toBe(false);
  });
});

describe("attachmentNamingFromEnv", () => {
  it("defaults to id names and no folders", () => {
    expect(attachmentNamingFromEnv({})).toEqual({ names: "id", folders: "none" });
    expect(
      attachmentNamingFromEnv({ ATTACHMENT_COPY_NAMES: " ", ATTACHMENT_COPY_FOLDERS: "" }),
    ).toEqual({ names: "id", folders: "none" });
  });

  it("reads readable names and month folders", () => {
    expect(
      attachmentNamingFromEnv({
        ATTACHMENT_COPY_NAMES: "readable",
        ATTACHMENT_COPY_FOLDERS: "month",
      }),
    ).toEqual({ names: "readable", folders: "month" });
  });

  it("throws an error naming the setting for any other value", () => {
    expect(() => attachmentNamingFromEnv({ ATTACHMENT_COPY_NAMES: "nice" })).toThrow(
      "ATTACHMENT_COPY_NAMES",
    );
    expect(() => attachmentNamingFromEnv({ ATTACHMENT_COPY_FOLDERS: "yearly" })).toThrow(
      "ATTACHMENT_COPY_FOLDERS",
    );
  });
});
