import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDriveMcpServer } from "./google-drive-mcp.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function fixture(responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected network call");
    return response;
  });
  const server = createDriveMcpServer("fake-access-token", fetcher);
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(
    () => client.close(),
    () => server.close(),
  );
  return { client, fetcher };
}

describe("direct Drive MCP", () => {
  it("escapes search values, preserves pagination and never follows redirects with credentials", async () => {
    const { client, fetcher } = await fixture([
      Response.json({ files: [], nextPageToken: "next" }),
    ]);
    const result = await client.callTool({
      name: "search_files",
      arguments: { name: "a' or trashed = true", pageToken: "page" },
    });
    const [url, init] = fetcher.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe("https://www.googleapis.com");
    expect(parsed.searchParams.get("q")).toBe(
      "trashed = false and name contains 'a\\' or trashed = true'",
    );
    expect(parsed.searchParams.get("pageToken")).toBe("page");
    expect(init).toMatchObject({
      redirect: "error",
      headers: { Authorization: "Bearer fake-access-token" },
    });
    expect(JSON.stringify(result)).toContain("nextPageToken");
    expect(JSON.stringify(result)).not.toContain("fake-access-token");
  });

  it("exports native documents instead of requesting unsupported binary downloads", async () => {
    const { client, fetcher } = await fixture([
      Response.json({ mimeType: "application/vnd.google-apps.document" }),
      new Response("Document text"),
    ]);
    const result = await client.callTool({ name: "read_file", arguments: { fileId: "doc_1" } });
    expect(String(fetcher.mock.calls[1]![0])).toContain("/doc_1/export?mimeType=text%2Fplain");
    expect(JSON.stringify(result)).toContain("Document text");
  });

  it("rejects path injection before making a request", async () => {
    const { client, fetcher } = await fixture([]);
    const result = await client.callTool({
      name: "read_file",
      arguments: { fileId: "../other?alt=media" },
    });
    expect(result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds downloads even when the metadata omits size", async () => {
    const { client } = await fixture([
      Response.json({ mimeType: "text/plain" }),
      new Response("x".repeat(2 * 1024 * 1024 + 1)),
    ]);
    const result = await client.callTool({ name: "read_file", arguments: { fileId: "file_1" } });
    expect(result.isError).toBe(true);
  });

  it("does not expose an authorization failure body or retry a failed upload", async () => {
    const { client, fetcher } = await fixture([new Response("fake-access-token", { status: 401 })]);
    const result = await client.callTool({
      name: "create_text_file",
      arguments: { name: "note.txt", text: "Hello" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fake-access-token");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("marks uploads as writes and sends metadata and UTF-8 content separately", async () => {
    const { client, fetcher } = await fixture([Response.json({ id: "created" })]);
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "create_text_file")?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
    });
    await client.callTool({
      name: "create_text_file",
      arguments: { name: "note.txt", text: "안녕하세요", parentId: "folder_1" },
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain("/upload/drive/v3/files?");
    expect(init?.method).toBe("POST");
    expect(init?.body).toContain('"parents":["folder_1"]');
    expect(init?.body).toContain("안녕하세요");
  });
});
