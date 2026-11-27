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

export function createTextTurn(input: { cwd: string; prompt: string }) {
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
                prompt: [{ type: "text", text: prompt }],
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
