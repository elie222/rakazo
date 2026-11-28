import { describe, expect, it } from "vitest";
import { createInlinePngTurn } from "./acp-text.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=",
  "base64",
);
const encode = (frame: object) => JSON.stringify({ jsonrpc: "2.0", ...frame });
const start = (cap?: boolean) =>
  encode({
    id: 1,
    result: {
      protocolVersion: 1,
      ...(cap === undefined ? {} : { agentCapabilities: { promptCapabilities: { image: cap } } }),
    },
  });
const input = {
  cwd: "/isolated",
  prompt: "Describe the fixture",
  png,
  modelImageCapability: "supported",
} as const;

describe("Unregistered single PNG ACP probe codec", () => {
  it("sends the PNG with its original bytes only after capability negotiation and session admission", () => {
    const prefixed = Buffer.concat([Buffer.from([1, 2]), png]);
    const turn = createInlinePngTurn({ ...input, png: prefixed.subarray(2) });
    expect(turn.initialize.method).toBe("initialize");
    expect(turn.receive(start(true)).send).toMatchObject({
      method: "session/new",
      params: { cwd: "/isolated", mcpServers: [] },
    });
    expect(turn.receive(encode({ id: 2, result: { sessionId: "chosen" } })).send).toMatchObject({
      method: "session/prompt",
      params: {
        sessionId: "chosen",
        prompt: [
          { type: "text", text: input.prompt },
          { type: "image", mimeType: "image/png", data: png.toString("base64") },
        ],
      },
    });
  });

  it.each([true, false])(
    "stops on a wrong session even after an image-capable handshake (%s)",
    (includeText) => {
      const turn = createInlinePngTurn(input);
      turn.receive(start(true));
      turn.receive(encode({ id: 2, result: { sessionId: "chosen" } }));
      if (includeText)
        expect(
          turn.receive(
            encode({
              method: "session/update",
              params: {
                sessionId: "chosen",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "Hi" },
                },
              },
            }),
          ).text,
        ).toBe("Hi");
      expect(() =>
        turn.receive(
          encode({
            method: "session/update",
            params: {
              sessionId: "other",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Private" },
              },
            },
          }),
        ),
      ).toThrow("ACP turn rejected");
    },
  );

  it.each([undefined, false])(
    "stops before session creation when image capability is %s",
    (cap) => {
      const turn = createInlinePngTurn(input);
      expect(() => turn.receive(start(cap))).toThrow("ACP turn rejected");
      expect(() => turn.receive(start(true))).toThrow("ACP turn rejected");
    },
  );

  it.each(["unsupported", "unverified"] as const)(
    "does not initialize for a selected model with %s image support",
    (modelImageCapability) => {
      expect(() => createInlinePngTurn({ ...input, modelImageCapability })).toThrow(
        "ACP turn rejected",
      );
    },
  );

  it("rejects oversized bytes, unknown formats, truncated headers and oversized rasters", () => {
    const oversized = Buffer.alloc(512 * 1024 + 1);
    png.copy(oversized);
    const huge = Buffer.from(png);
    huge.writeUInt32BE(4096, 16);
    huge.writeUInt32BE(4096, 20);
    for (const bad of [oversized, huge, png.subarray(0, 28), Buffer.from("not a PNG")]) {
      expect(() => createInlinePngTurn({ ...input, png: bad })).toThrow("ACP turn rejected");
    }
  });
});
