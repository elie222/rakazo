// A stand-in agent CLI for the ACP runtime tests. It speaks the Agent Client Protocol over stdio
// and records what it was started with and asked, one JSON line per event, to the file named by
// its first argument. What it does on a prompt depends on words in the prompt text:
//   "weather"     calls the tool server's get_weather tool and replies with its result
//   "note"        calls send_note, then waits to be cancelled
//   "takeover"    calls request_takeover, then waits to be cancelled
//   "native"      reports a call to a tool of its own
//   "permission"  asks permission to run a tool of its own
//   "fail"        answers the prompt with an error
//   "silent"      ends the turn without a reply
// anything else gets the reply "ok".
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [recordFile] = process.argv.slice(2);
const record = (event) => appendFileSync(recordFile, `${JSON.stringify(event)}\n`);
record({ type: "start", argv: process.argv.slice(3), env: process.env, cwd: process.cwd() });

// The sessions it keeps, as a real CLI keeps them on disk between runs.
const sessionsFile = `${recordFile}.sessions`;
const known = () =>
  new Set(
    existsSync(sessionsFile) ? readFileSync(sessionsFile, "utf8").split("\n").filter(Boolean) : [],
  );
const servers = new Map();
let nextId = 1;
const waiting = new Map();
// Settles once the client cancels the turn, whenever the cancel arrives.
let cancel;
const cancelled = new Promise((resolve) => {
  cancel = resolve;
});

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, update) =>
  send({ method: "session/update", params: { sessionId, update } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = `agent-${nextId++}`;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

async function mcp(server, method, params) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  for (const header of server.headers ?? []) headers[header.name] = header.value;
  const response = await fetch(server.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return (await response.json()).result;
}

async function callTool(sessionId, name, args) {
  const server = servers.get(sessionId);
  const unauthorized = await fetch(server.url, { method: "POST", body: "{}" });
  record({ type: "unauthenticated", status: unauthorized.status });
  await mcp(server, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fake", version: "1" },
  });
  const { tools } = await mcp(server, "tools/list", {});
  record({ type: "tools", names: tools.map((tool) => tool.name) });
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    name: `rakazo_${name}`,
    title: name,
    status: "pending",
  });
  const result = await mcp(server, "tools/call", { name, arguments: args });
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "completed",
  });
  return result;
}

async function prompt(params) {
  const { sessionId } = params;
  const text = params.prompt.map((block) => block.text ?? "").join("\n");
  if (text.includes("fail"))
    throw Object.assign(new Error("Model is overloaded"), { code: -32603 });
  if (text.includes("native")) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "call-9",
      name: "bash",
      title: "ls ~",
    });
    await new Promise(() => {});
  }
  if (text.includes("permission")) {
    await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "call-8", title: "bash" },
      options: [
        { optionId: "once", kind: "allow_once", name: "Allow" },
        { optionId: "no", kind: "reject_once", name: "Reject" },
      ],
    });
    await new Promise(() => {});
  }
  update(sessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "hmm" },
  });
  if (text.includes("silent")) return { stopReason: "end_turn" };
  // Rakazo's continuation after an approval: call the approved request as listed, as a model would.
  const approved = text.includes("approved the exact tool request")
    ? /^(\w+): (\{.*\})$/m.exec(text)
    : null;
  if (approved) {
    const result = await callTool(sessionId, approved[1], JSON.parse(approved[2]));
    record({ type: "tool_result", result });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Done: ${result.content[0].text}` },
    });
    return { stopReason: "end_turn" };
  }
  if (text.includes("weather")) {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Checking. " },
    });
    const result = await callTool(sessionId, "get_weather", { city: "Paris" });
    record({ type: "tool_result", result });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `It is ${result.content[0].text}.` },
    });
    return {
      stopReason: "end_turn",
      usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 },
    };
  }
  if (text.includes("takeover")) {
    const result = await callTool(sessionId, "request_takeover", { reason: "Log in for me" });
    record({ type: "tool_result", result });
    await cancelled;
    return { stopReason: "cancelled" };
  }
  if (text.includes("note")) {
    const result = await callTool(sessionId, "send_note", { text: "hi" });
    record({ type: "tool_result", result });
    await cancelled;
    return { stopReason: "cancelled" };
  }
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "ok" },
  });
  return { stopReason: "end_turn" };
}

const modelOption = (value) => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: value,
  options: [
    { value: "fake/default", name: "Default" },
    { value: "fake/large", name: "Large" },
  ],
});

async function handle(message) {
  const { method, params } = message;
  record({ type: "request", method, params });
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          sessionCapabilities: { resume: {}, delete: {} },
        },
      };
    case "session/new": {
      if (params._meta?.fake?.signedOut) {
        throw Object.assign(new Error("Authentication required"), { code: -32000 });
      }
      const sessionId = `ses-${randomUUID()}`;
      servers.set(sessionId, params.mcpServers[0]);
      appendFileSync(sessionsFile, `${sessionId}\n`);
      return { sessionId, configOptions: [modelOption("fake/default")] };
    }
    case "session/resume":
      if (!known().has(params.sessionId)) {
        throw Object.assign(new Error("Session not found"), { code: -32602 });
      }
      servers.set(params.sessionId, params.mcpServers[0]);
      return { configOptions: [modelOption("fake/large")] };
    case "session/set_config_option":
    case "session/delete":
      return {};
    case "session/prompt":
      return prompt(params);
    default:
      throw Object.assign(new Error("Method not found"), { code: -32601 });
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    waiting.get(message.id)?.(message.result);
    continue;
  }
  if (message.id === undefined) {
    record({ type: "notification", method: message.method, params: message.params });
    if (message.method === "session/cancel") cancel();
    continue;
  }
  handle(message).then(
    (result) => send({ id: message.id, result }),
    (error) =>
      send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }),
  );
}
