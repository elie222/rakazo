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

describe("spreadsheet reading", () => {
  function content(result: Awaited<ReturnType<Client["callTool"]>>) {
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  }

  it("lists later and hidden tabs without downloading grid contents", async () => {
    const spreadsheet = {
      spreadsheetId: "book_1",
      sheets: [
        { properties: { sheetId: 0, title: "Summary", gridProperties: { rowCount: 1000 } } },
        { properties: { sheetId: 7, title: "지역 목록", hidden: true } },
      ],
      namedRanges: [{ name: "venues", range: { sheetId: 7 } }],
    };
    const { client, fetcher } = await fixture([Response.json(spreadsheet)]);
    expect(
      content(
        await client.callTool({ name: "get_spreadsheet", arguments: { spreadsheetId: "book_1" } }),
      ),
    ).toEqual(spreadsheet);
    const [url, init] = fetcher.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe("https://sheets.googleapis.com");
    expect(parsed.pathname).toBe("/v4/spreadsheets/book_1");
    expect(parsed.searchParams.get("fields")).toContain("sheets(properties(");
    expect(parsed.searchParams.get("fields")).not.toContain("rowData");
    expect(init).toMatchObject({
      redirect: "error",
      headers: { Authorization: "Bearer fake-access-token" },
    });
  });

  it("reads named tabs and multiple ranges in order without changing formulas or sparse rows", async () => {
    const ranges = ["'지역 목록'!A1:C20", "'Owner''s & Notes'!B21:D40"];
    const data = {
      spreadsheetId: "book_1",
      valueRanges: [
        { range: ranges[0], values: [["Name", "Count"], ["Hall", 3], [], ["Other", 0]] },
        { range: ranges[1], values: [["=SUM(C1:C4)", true]] },
      ],
    };
    const { client, fetcher } = await fixture([Response.json(data)]);
    expect(
      content(
        await client.callTool({
          name: "read_spreadsheet_ranges",
          arguments: {
            spreadsheetId: "book_1",
            ranges,
            valueRenderOption: "FORMULA",
            dateTimeRenderOption: "SERIAL_NUMBER",
          },
        }),
      ),
    ).toEqual(data);
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.origin).toBe("https://sheets.googleapis.com");
    expect(url.pathname).toBe("/v4/spreadsheets/book_1/values:batchGet");
    expect(url.searchParams.getAll("ranges")).toEqual(ranges);
    expect(url.searchParams.get("majorDimension")).toBe("ROWS");
    expect(url.searchParams.get("valueRenderOption")).toBe("FORMULA");
    expect(url.searchParams.get("dateTimeRenderOption")).toBe("SERIAL_NUMBER");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("defaults to displayed values and supports computed values with readable dates", async () => {
    const { client, fetcher } = await fixture([
      Response.json({ valueRanges: [] }),
      Response.json({ valueRanges: [] }),
    ]);
    for (const valueRenderOption of [undefined, "UNFORMATTED_VALUE"]) {
      await client.callTool({
        name: "read_spreadsheet_ranges",
        arguments: {
          spreadsheetId: "book_1",
          ranges: ["'Data'!A1:B5"],
          ...(valueRenderOption ? { valueRenderOption } : {}),
        },
      });
    }
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get("valueRenderOption")).toBe(
      "FORMATTED_VALUE",
    );
    const second = new URL(String(fetcher.mock.calls[1]![0]));
    expect(second.searchParams.get("valueRenderOption")).toBe("UNFORMATTED_VALUE");
    expect(second.searchParams.get("dateTimeRenderOption")).toBe("FORMATTED_STRING");
  });

  it("rejects invalid identifiers, empty ranges and oversized batches before fetching", async () => {
    const { client, fetcher } = await fixture([]);
    for (const args of [
      { spreadsheetId: "../other", ranges: ["A1"] },
      { spreadsheetId: "book_1", ranges: [] },
      { spreadsheetId: "book_1", ranges: [" "] },
      { spreadsheetId: "book_1", ranges: Array(21).fill("A1") },
    ])
      expect(
        (await client.callTool({ name: "read_spreadsheet_ranges", arguments: args })).isError,
      ).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails oversized reads without returning partial counts or exposing provider failures", async () => {
    const { client, fetcher } = await fixture([
      new Response("x".repeat(2 * 1024 * 1024 + 1)),
      new Response("private provider body fake-access-token", { status: 403 }),
    ]);
    for (let i = 0; i < 2; i++) {
      const result = await client.callTool({
        name: "read_spreadsheet_ranges",
        arguments: { spreadsheetId: "book_1", ranges: ["A1:Z100"] },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Google Sheets API");
      expect(JSON.stringify(result)).not.toContain("private provider");
      expect(JSON.stringify(result)).not.toContain("fake-access-token");
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    const { tools } = await client.listTools();
    for (const name of ["get_spreadsheet", "read_spreadsheet_ranges"]) {
      expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
    }
  });

  it("makes the legacy CSV limitation explicit and directs callers to range reading", async () => {
    const { client } = await fixture([
      Response.json({ mimeType: "application/vnd.google-apps.spreadsheet" }),
      new Response("Name,Count\nFirst tab,2"),
    ]);
    const result = content(
      await client.callTool({ name: "read_file", arguments: { fileId: "book_1" } }),
    );
    expect(result.content).toBe("Name,Count\nFirst tab,2");
    expect(result.notice).toContain("read_spreadsheet_ranges");
  });
});
