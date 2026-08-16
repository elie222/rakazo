import type { ProcessEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerSandboxProvider } from "./docker-sandbox.js";

const context = {
  operationId: "docker-test",
  traceId: "docker-test",
  workspaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

describe("Docker sandbox command timeout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the bounded timeout to the supervisor and preserves its honest result", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        stdout: "partial output\n",
        stderr: "command timed out after 75 ms\n",
        code: 124,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const events: ProcessEvent[] = [];

    for await (const event of provider.execute(
      { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
      { argv: ["sleep", "10"], timeoutMs: 75 },
      context,
    )) {
      events.push(event);
    }

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      argv: ["sleep", "10"],
      cwd: "/home/rakazo",
      timeoutMs: 75,
    });
    expect(events).toEqual([
      { type: "stdout", data: "partial output\n" },
      { type: "stderr", data: "command timed out after 75 ms\n" },
      { type: "exit", code: 124 },
    ]);
  });
});
