import { detectImageMimeType } from "../../../media/image-mime-type.js";

/**
 * One-turn Kimi Code ACP protocol, as documented for the CLI. This deliberately
 * owns no launcher: denying reverse RPC is not an OS sandbox. Do not register
 * for live execution until an independently verified isolated launcher exists.
 */
type Frame = Record<string, unknown>;
type Request = { jsonrpc: "2.0"; id: number; method: string; params: Frame };
type Action = { send?: Request | Frame; text?: string; done?: true; denied?: true };

const fail = (): never => {
  throw new Error("Kimi Code ACP turn rejected.");
};

function object(value: unknown): Frame {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Frame;
}

function request(id: number, method: string, params: Frame): Request {
  return { jsonrpc: "2.0", id, method, params };
}

type TextInput = { cwd: string; prompt: string };
type InlinePng = { type: "image"; mimeType: "image/png"; data: string };

const MAX_PNG_BYTES = 512 * 1024;
const MAX_PNG_SIDE = 4096;
const MAX_PNG_PIXELS = 4 * 1024 * 1024;

export function createTextTurn(input: TextInput) {
  return createTurn(input);
}

/** Protocol-only test surface. The existing text bridge does not send or replay attachments. */
export function createInlinePngTurn(input: TextInput & { png: Uint8Array }) {
  const { png } = input;
  if (png.byteLength < 33 || png.byteLength > MAX_PNG_BYTES) return fail();
  if (detectImageMimeType(png) !== "image/png") return fail();
  // Bound the declared raster without decoding: upstream must still validate/normalize pixels.
  const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452) return fail();
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_PNG_SIDE ||
    height > MAX_PNG_SIDE ||
    width * height > MAX_PNG_PIXELS
  )
    return fail();
  return createTurn(input, {
    type: "image",
    mimeType: "image/png",
    data: Buffer.from(png).toString("base64"),
  });
}

function createTurn(input: TextInput, image?: InlinePng) {
  const { cwd, prompt } = input;
  if (!cwd.startsWith("/") || !prompt.trim() || Buffer.byteLength(prompt) > 131072) fail();
  let awaiting = 1;
  let sessionId: string | undefined;
  let bytes = 0;
  let broken = false;
  return {
    initialize: request(1, "initialize", { protocolVersion: 1, clientCapabilities: {} }),
    receive(line: string): Action {
      if (broken || awaiting === 0 || Buffer.byteLength(line) > 131072) return fail();
      try {
        const frame = object(JSON.parse(line));
        if (frame.jsonrpc !== "2.0") return fail();
        if (typeof frame.method === "string") {
          if ("id" in frame) {
            const id = frame.id;
            if (typeof id !== "string" && typeof id !== "number") return fail();
            broken = true;
            if (frame.method === "session/request_permission") {
              return {
                denied: true,
                send: { jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } },
              };
            }
            return {
              denied: true,
              send: { jsonrpc: "2.0", id, error: { code: -32601, message: "Not supported" } },
            };
          }
          if (frame.method !== "session/update") return fail();
          const params = object(frame.params);
          if (awaiting !== 3 || params.sessionId !== sessionId) return fail();
          const update = object(params.update);
          switch (update.sessionUpdate) {
            case "agent_message_chunk": {
              const content = object(update.content);
              if (content.type !== "text" || typeof content.text !== "string") return fail();
              bytes += Buffer.byteLength(content.text);
              if (bytes > 131072) return fail();
              return { text: content.text };
            }
            case "agent_thought_chunk":
            case "available_commands_update":
            case "current_mode_update":
            case "config_option_update":
            // Kimi Code also sends session title metadata ahead of the first text chunk.
            case "session_info_update":
              return {};
            default:
              return fail();
          }
        }
        if (frame.id !== awaiting || "error" in frame) return fail();
        const result = object(frame.result);
        switch (awaiting) {
          case 1:
            if (result.protocolVersion !== 1) return fail();
            if (image && object(object(result.agentCapabilities).promptCapabilities).image !== true)
              return fail();
            awaiting = 2;
            return { send: request(2, "session/new", { cwd, mcpServers: [] }) };
          case 2:
            if (
              typeof result.sessionId !== "string" ||
              !result.sessionId ||
              result.sessionId.length > 256
            ) {
              return fail();
            }
            sessionId = result.sessionId;
            awaiting = 3;
            return {
              send: request(3, "session/prompt", {
                sessionId,
                prompt: image
                  ? [{ type: "text", text: prompt }, image]
                  : [{ type: "text", text: prompt }],
              }),
            };
          case 3:
            if (result.stopReason !== "end_turn" || bytes === 0) return fail();
            awaiting = 0;
            return { done: true };
          default:
            return fail();
        }
      } catch {
        broken = true;
        return fail();
      }
    },
  };
}
