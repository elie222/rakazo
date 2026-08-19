import { describe, expect, it } from "vitest";
import { MessageBlock, validateThreadsSendInput } from "./index.js";

describe("attachment contracts", () => {
  it("parses image and file message blocks", () => {
    expect(
      MessageBlock.parse({
        kind: "image",
        artifactId: "art_1",
        mimeType: "image/png",
        name: "shot.png",
      }),
    ).toMatchObject({ kind: "image", name: "shot.png" });
    expect(
      MessageBlock.parse({
        kind: "file",
        artifactId: "art_2",
        mimeType: "application/pdf",
        name: "brief.pdf",
        size: 1234,
      }),
    ).toMatchObject({ kind: "file", size: 1234 });
  });

  it("requires text or attachments for threads.send", () => {
    expect(validateThreadsSendInput({ text: "hello" })).toBe(true);
    expect(validateThreadsSendInput({ artifactIds: ["art_1"] })).toBe(true);
    expect(validateThreadsSendInput({})).toBe(false);
    expect(validateThreadsSendInput({ artifactIds: ["a", "b", "c", "d", "e"] })).toBe(true);
  });
});
