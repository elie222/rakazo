import { ATTACHMENT_MAX_BASE64_LENGTH } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { liftMcpResultImages } from "./mcp-result-images.js";
import { MCP_IMAGE_ATTACHED, MCP_IMAGE_NOT_ATTACHED } from "./mcp-result-images.prompt.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(30_000, 7),
]).toString("base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]).toString(
  "base64",
);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00").toString("base64");

describe("MCP result images", () => {
  it("moves each image into its own part and keeps the rest of the result", () => {
    const result = {
      content: [
        { type: "text", text: "Preview of page 1" },
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "image", data: JPEG, mimeType: "image/jpeg", annotations: { audience: ["user"] } },
      ],
      structuredContent: { pageId: "page-1" },
      isError: false,
    };

    const lifted = liftMcpResultImages(result);

    expect(lifted.images).toEqual([
      { type: "image", data: PNG, mimeType: "image/png" },
      { type: "image", data: JPEG, mimeType: "image/jpeg" },
    ]);
    expect(lifted.result).toEqual({
      content: [
        { type: "text", text: "Preview of page 1" },
        { type: "image", data: MCP_IMAGE_ATTACHED, mimeType: "image/png" },
        {
          type: "image",
          data: MCP_IMAGE_ATTACHED,
          mimeType: "image/jpeg",
          annotations: { audience: ["user"] },
        },
      ],
      structuredContent: { pageId: "page-1" },
      isError: false,
    });
    expect(result.content[1]).toEqual({ type: "image", data: PNG, mimeType: "image/png" });
  });

  it("takes the format from the bytes, not the server's label", () => {
    const lifted = liftMcpResultImages({
      content: [{ type: "image", data: PNG, mimeType: "image/jpeg" }],
    });

    expect(lifted.images).toEqual([{ type: "image", data: PNG, mimeType: "image/png" }]);
  });

  it("attaches the base64 it checked, without surrounding whitespace", () => {
    const lifted = liftMcpResultImages({
      content: [{ type: "image", data: `\n${PNG}\n`, mimeType: "image/png" }],
    });

    expect(lifted.images).toEqual([{ type: "image", data: PNG, mimeType: "image/png" }]);
  });

  it("notes images it cannot attach instead of passing their data on", () => {
    const tooLarge = PNG.slice(0, 12) + "A".repeat(ATTACHMENT_MAX_BASE64_LENGTH);
    const unattached = [GIF, `${PNG.slice(0, 40)}!${PNG.slice(41)}`, `${PNG}A`, tooLarge];

    const lifted = liftMcpResultImages({
      content: unattached.map((data) => ({ type: "image", data, mimeType: "image/png" })),
    });

    expect(lifted.images).toEqual([]);
    expect(lifted.result).toEqual({
      content: unattached.map(() => ({
        type: "image",
        data: MCP_IMAGE_NOT_ATTACHED,
        mimeType: "image/png",
      })),
    });
  });

  it("returns a result without image parts as it is", () => {
    for (const result of [
      { content: [{ type: "text", text: "no pictures" }] },
      { content: "not a list" },
      { rows: [] },
      "plain text",
      null,
    ]) {
      const lifted = liftMcpResultImages(result);
      expect(lifted.result).toBe(result);
      expect(lifted.images).toEqual([]);
    }
  });
});
