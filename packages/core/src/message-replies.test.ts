import type { MessageBlock } from "@rakazo/contracts";
import { ReplyPreviewSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { replyAttachment, replyLabel, replyLineText, replyMetadata } from "./message-replies.js";

describe("shared reply presentation", () => {
  it("keeps selected quotes on one line and uses preview before local fallback", () => {
    expect(replyLineText("First\nSecond", "preview", "fallback")).toBe("First Second");
    expect(replyLineText(undefined, "First\nSecond", "fallback")).toBe("First");
    expect(replyLineText(undefined, undefined, "Local\nSecond")).toBe("Local");
    expect(replyLineText()).toBe("");
  });
  it("preserves omitted metadata and accepts authoritative unavailable previews", () => {
    const previous = {
      replyToMessageId: "parent",
      replyQuote: "",
      replyPreview: { role: "bot" as const, text: "Earlier" },
    };
    expect(replyMetadata({}, previous)).toEqual(previous);
    expect(replyMetadata({ replyPreview: { text: 12 } }, previous)).toEqual(previous);
    expect(replyMetadata({ replyPreview: null }, previous)).toEqual({
      ...previous,
      replyPreview: null,
    });
    expect(
      replyMetadata(
        {
          replyQuote: "new",
          replyToMessageId: "other",
          replyPreview: { role: "user", text: "New" },
        },
        previous,
      ),
    ).toEqual({
      replyQuote: "new",
      replyToMessageId: "other",
      replyPreview: { role: "user", text: "New" },
    });
  });
});

const image: MessageBlock = { kind: "image", artifactId: "photo", mimeType: "image/png", name: "" };
const file: MessageBlock = {
  kind: "file",
  artifactId: "document",
  mimeType: "text/plain",
  name: "notes.txt",
  size: 12,
};
it("prefers the first parent image and copies only attachment metadata", () => {
  expect(replyAttachment([file, image, { ...image, artifactId: "second" }])).toEqual(image);
  expect(replyAttachment([file])).toEqual({
    kind: "file",
    artifactId: "document",
    mimeType: "text/plain",
    name: "notes.txt",
  });
  expect(replyAttachment([])).toBeUndefined();
});
it("uses quote, caption, localized photo, filename, and attachment in order", () => {
  const labels = { photo: "Foto", attachment: "Anhang" };
  expect(replyLabel("selected\ntext", "caption", image, labels)).toBe("selected text");
  expect(replyLabel(undefined, "caption", image, labels)).toBe("caption");
  expect(replyLabel(undefined, "", image, labels)).toBe("Foto");
  expect(replyLabel(undefined, "", replyAttachment([file]), labels)).toBe("notes.txt");
  expect(replyLabel(undefined, "", { ...file, name: "" }, labels)).toBe("Anhang");
});
it.each([
  { role: "user", text: "legacy" },
  { role: "bot", botId: "bot", text: "legacy" },
])("accepts legacy previews and strips unexpected top-level fields: %j", (preview) => {
  expect(ReplyPreviewSchema.parse(preview)).toEqual(preview);
  expect(ReplyPreviewSchema.parse({ ...preview, source: "cache" })).toEqual(preview);
});
it("strips unknown preview and attachment fields and preserves known metadata in events", () => {
  const preview = { role: "user", text: "", attachment: image };
  expect(replyMetadata({ replyPreview: preview }).replyPreview).toEqual(preview);
  const cachedPreview = {
    ...preview,
    source: "cache",
    attachment: { ...image, contentBase64: "bytes", size: 12 },
  };
  expect(ReplyPreviewSchema.safeParse(cachedPreview)).toEqual({ success: true, data: preview });
  expect(replyMetadata({ replyPreview: cachedPreview }).replyPreview).toEqual(preview);
});
it("still rejects missing or invalid known preview and attachment fields", () => {
  expect(ReplyPreviewSchema.safeParse({ role: "user" }).success).toBe(false);
  expect(ReplyPreviewSchema.safeParse({ role: "invalid", text: "" }).success).toBe(false);
  expect(ReplyPreviewSchema.safeParse({ role: "user", text: 12 }).success).toBe(false);
  const preview = { role: "user", text: "" };
  expect(ReplyPreviewSchema.safeParse({ ...preview, attachment: { kind: "image" } }).success).toBe(
    false,
  );
  expect(
    ReplyPreviewSchema.safeParse({ ...preview, attachment: { ...image, mimeType: 12 } }).success,
  ).toBe(false);
});

it("localizes legacy image-only quotes while retaining real selected caption text", () => {
  const labels = { photo: "Foto", attachment: "Anhang" };
  expect(replyLabel("[image: ]", "", image, labels)).toBe("Foto");
  expect(replyLabel("photo.png", "", { ...image, name: "photo.png" }, labels)).toBe("Foto");
  expect(
    replyLabel("photo.png", "Caption photo.png", { ...image, name: "photo.png" }, labels),
  ).toBe("photo.png");
});
