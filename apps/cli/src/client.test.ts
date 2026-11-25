import { describe, expect, it } from "vitest";
import { ApiError, createClient } from "./client.js";
import { readEvents } from "./sse.js";

function streamOf(...chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const config = { url: "https://rakazo.example.test", key: "rkz_key" };

describe("readEvents", () => {
  it("joins events split across chunks and skips keep-alives", async () => {
    const events = [];
    for await (const event of readEvents(
      streamOf("event: task\nda", 'ta: {"a":1}\n\n: keep-alive\n\n', "data: [DONE]\r\n\r\n"),
    ))
      events.push(event);
    expect(events).toEqual([
      { event: "task", data: '{"a":1}' },
      { event: "message", data: "[DONE]" },
    ]);
  });
});

describe("createClient", () => {
  it("streams a chat reply from OpenAI-style chunks, sending the key as a bearer", async () => {
    let request: Request | undefined;
    const client = createClient(config, async (input, init) => {
      request = new Request(input, init);
      return new Response(
        streamOf(
          `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
          "data: [DONE]\n\n",
        ),
      );
    });
    const parts = [];
    for await (const part of client.chat("Scout", "hi")) parts.push(part);
    expect(parts.join("")).toBe("Hello");
    expect(request?.url).toBe("https://rakazo.example.test/api/v1/chat/completions");
    expect(request?.headers.get("authorization")).toBe("Bearer rkz_key");
    expect(await request?.json()).toMatchObject({ model: "Scout", stream: true });
  });

  it("sends the key only over HTTPS, or plain HTTP to this machine", () => {
    expect(() => createClient({ url: "http://rakazo.example.test", key: "rkz_key" })).toThrow(
      "https://",
    );
    expect(() => createClient({ url: "http://localhost:5173", key: "rkz_key" })).not.toThrow();
  });

  it("fails a reply whose stream ends before it finishes", async () => {
    const client = createClient(
      config,
      async () =>
        new Response(
          streamOf(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`),
        ),
    );
    const parts: string[] = [];
    await expect(
      (async () => {
        for await (const part of client.chat("Scout", "hi")) parts.push(part);
      })(),
    ).rejects.toThrow("stopped before it finished");
    expect(parts).toEqual(["Hel"]);
  });

  it("reports the server's error message", async () => {
    const client = createClient(config, async () =>
      Response.json({ error: { message: "Invalid API key" } }, { status: 401 }),
    );
    await expect(client.bots()).rejects.toEqual(new ApiError(401, "Invalid API key"));
  });
});
