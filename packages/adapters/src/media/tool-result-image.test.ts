import type { AgentToolExecutionResult } from "@rakazo/adapter-kit";
import { createLogger, getLogger, installLogger } from "@rakazo/logging";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { imageToolResult, TOOL_IMAGE_MAX_EDGE } from "./tool-result-image.js";
import { IMAGE_MODEL_CANNOT_SEE, IMAGE_UNREADABLE } from "./tool-result-image.prompt.js";

function picture(
  width: number,
  height: number,
  format: "png" | "jpeg" | "gif" | "webp",
  red = 200,
) {
  return sharp({
    create: { width, height, channels: 3, background: { r: red, g: 30, b: 30 } },
  })
    .toFormat(format)
    .toBuffer();
}

function sent(result: unknown) {
  const tool = result as AgentToolExecutionResult;
  expect(tool.kind).toBe("agent_tool_result");
  const image = tool.content.find((part) => part.type === "image");
  if (!image || image.type !== "image") throw new Error("no image part");
  return { tool, image, bytes: Buffer.from(image.data, "base64") };
}

describe("imageToolResult", () => {
  const logger = getLogger();
  afterEach(() => installLogger(logger));

  it("hands a small PNG to the model unchanged in size", async () => {
    const result = await imageToolResult(await picture(40, 30, "png"), { path: "a.png" }, true);
    const { tool, image, bytes } = sent(result);
    expect(image.mimeType).toBe("image/png");
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 40, height: 30 });
    expect(tool.details).toEqual({ path: "a.png", mimeType: "image/png", width: 40, height: 30 });
    expect(tool.content[0]).toEqual({ type: "text", text: JSON.stringify(tool.details) });
  });

  it("scales a large photo to the edge limit and sends it as JPEG", async () => {
    const result = await imageToolResult(await picture(4000, 1000, "webp"), {}, true);
    const { tool, image, bytes } = sent(result);
    expect(image.mimeType).toBe("image/jpeg");
    const metadata = await sharp(bytes).metadata();
    expect(metadata.width).toBe(TOOL_IMAGE_MAX_EDGE);
    expect(metadata.height).toBe(Math.round(TOOL_IMAGE_MAX_EDGE / 4));
    expect(tool.details).toMatchObject({ mimeType: "image/webp", width: 4000, height: 1000 });
    expect(tool.details).toHaveProperty("scaledTo");
  });

  it("sends an animated GIF as its first frame", async () => {
    const frames = await Promise.all([picture(20, 10, "png"), picture(20, 10, "png", 10)]);
    const gif = await sharp(frames, { join: { animated: true } })
      .gif()
      .toBuffer();
    expect((await sharp(gif).metadata()).pages).toBe(2);
    const { bytes } = sent(await imageToolResult(gif, {}, true));
    const metadata = await sharp(bytes, { animated: true }).metadata();
    expect([metadata.width, metadata.height, metadata.pages ?? 1]).toEqual([20, 10, 1]);
  });

  it("gives a text-only model a note and no pixels", async () => {
    const result = await imageToolResult(
      await picture(40, 30, "png"),
      { url: "https://x.test/a" },
      false,
    );
    expect(result).toEqual({
      url: "https://x.test/a",
      mimeType: "image/png",
      error: IMAGE_MODEL_CANNOT_SEE,
    });
  });

  it("reports a corrupt picture instead of sending it, and logs why", async () => {
    const events: Array<Record<string, unknown>> = [];
    installLogger(
      createLogger({
        service: "test",
        sinks: [
          {
            write: (event) => {
              events.push(event);
            },
          },
        ],
      }),
    );
    const png = await picture(40, 30, "png");
    const result = await imageToolResult(png.subarray(0, 40), {}, true);
    expect(result).toMatchObject({ error: IMAGE_UNREADABLE });
    expect(events).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "tool_image.decode_failed",
        "image.format": "image/png",
        error: expect.anything(),
      }),
    ]);
    expect(await imageToolResult(new TextEncoder().encode("hello"), {}, true)).toMatchObject({
      error: IMAGE_UNREADABLE,
    });
  });
});
