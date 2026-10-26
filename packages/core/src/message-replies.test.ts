import type { MessageBlock } from "@rakazo/contracts";
import { ReplyPreviewSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  channelMessageSender,
  previewMessageText,
  replyAttachment,
  replyLabel,
  replyLineText,
  replyMetadata,
} from "./message-replies.js";

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

describe("channelMessageSender", () => {
  const channel = {
    kind: "channel_message" as const,
    provider: "telegram",
    channelId: "channel",
    fromAddress: "ada",
    fromLabel: "Ada",
    text: "On my way",
  };

  it("names the outside sender of a relayed message", () => {
    expect(channelMessageSender([channel])).toBe("Ada");
  });

  it("is undefined for the user's own messages and for a blank sender", () => {
    expect(channelMessageSender([{ kind: "text", text: "hi" }])).toBeUndefined();
    expect(channelMessageSender([{ ...channel, fromLabel: "  " }])).toBeUndefined();
  });
});

describe("previewMessageText", () => {
  const labels = { photo: "Photo", attachment: "Attachment", message: "Message" };

  it("joins text, reading bot Markdown as plain text", () => {
    expect(
      previewMessageText(
        {
          role: "bot",
          blocks: [
            { kind: "text", text: "**Hello**" },
            { kind: "text", text: "there" },
          ],
        },
        labels,
      ),
    ).toBe("Hello there");
    expect(
      previewMessageText({ role: "user", blocks: [{ kind: "text", text: "**hi**" }] }, labels),
    ).toBe("**hi**");
  });

  it("shows a channel message's text alone, like the server preview", () => {
    expect(
      previewMessageText(
        {
          role: "user",
          blocks: [
            {
              kind: "channel_message",
              provider: "telegram",
              channelId: "channel",
              fromAddress: "ada",
              fromLabel: "Ada",
              text: "On my way",
            },
          ],
        },
        labels,
      ),
    ).toBe("On my way");
  });

  it("falls back to attachment labels, then a generic label", () => {
    const image = { kind: "image", artifactId: "a", mimeType: "image/png", name: "a.png" } as const;
    const file = { kind: "file", artifactId: "f", mimeType: "application/pdf", size: 1 } as const;
    expect(previewMessageText({ role: "user", blocks: [image] }, labels)).toBe("Photo");
    expect(previewMessageText({ role: "user", blocks: [{ ...file, name: "a.pdf" }] }, labels)).toBe(
      "a.pdf",
    );
    expect(previewMessageText({ role: "user", blocks: [{ ...file, name: "" }] }, labels)).toBe(
      "Attachment",
    );
    expect(previewMessageText({ role: "bot", blocks: [] }, labels)).toBe("Message");
  });
});
