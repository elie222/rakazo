import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readBoundedResponseBytes, withAbort } from "@rakazo/core";
import { z } from "zod";

const MAX_BYTES = 2 * 1024 * 1024;
const API = "https://www.googleapis.com";
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,webViewLink,parents";
const fileId = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(256);

/** Rakazo owns OAuth and refresh; this process receives only a short-lived access token. */
export function createDriveMcpServer(accessToken: string, fetcher: typeof fetch = fetch) {
  if (!accessToken || /[\r\n]/.test(accessToken)) throw new Error("An access token is required");
  const server = new McpServer({ name: "google-drive", version: "1.0.0" });

  async function request(path: string, init: RequestInit = {}, signal?: AbortSignal) {
    const deadline = AbortSignal.timeout(30_000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const response = await fetcher(`${API}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: combined,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      // Never forward provider bodies, request headers or transport errors to the model.
      throw new Error(`Drive request failed (${response.status})`);
    }
    return readBoundedResponseBytes(response, {
      maxBytes: MAX_BYTES,
      tooLargeMessage: "File exceeds the 2 MiB tool limit",
      read: (operation) => withAbort(operation(), combined),
    });
  }

  function json(bytes: Uint8Array): unknown {
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async function result(action: () => Promise<unknown>) {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await action()) }] };
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "Drive request failed. Check authorization, file access and the 2 MiB tool limit before retrying.",
          },
        ],
      };
    }
  }

  server.registerTool(
    "search_files",
    {
      description:
        "Search Google Drive files by name. Returns one page with a nextPageToken when more files exist.",
      inputSchema: {
        name: z.string().max(500).optional(),
        parentId: fileId.optional(),
        pageToken: z.string().max(4096).optional(),
        pageSize: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    ({ name, parentId, pageToken, pageSize }, extra) =>
      result(async () => {
        const escapeQuery = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const clauses = ["trashed = false"];
        if (name) clauses.push(`name contains '${escapeQuery(name)}'`);
        if (parentId) clauses.push(`'${parentId}' in parents`);
        const params = new URLSearchParams({
          q: clauses.join(" and "),
          pageSize: String(pageSize),
          fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
        });
        if (pageToken) params.set("pageToken", pageToken);
        return json(await request(`/drive/v3/files?${params}`, {}, extra.signal));
      }),
  );

  server.registerTool(
    "read_file",
    {
      description:
        "Read a Google Drive file (up to 2 MiB). Native Docs export as text, Sheets as CSV, Slides as text. Other files return base64 bytes.",
      inputSchema: { fileId },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    ({ fileId: id }, extra) =>
      result(async () => {
        const metadata = json(
          await request(
            `/drive/v3/files/${id}?supportsAllDrives=true&fields=${FILE_FIELDS}`,
            {},
            extra.signal,
          ),
        ) as { mimeType: string; size?: string };
        if (Number(metadata.size) > MAX_BYTES) throw new Error("File too large");
        const exports: Record<string, string> = {
          "application/vnd.google-apps.document": "text/plain",
          "application/vnd.google-apps.spreadsheet": "text/csv",
          "application/vnd.google-apps.presentation": "text/plain",
        };
        const exportType = exports[metadata.mimeType];
        if (metadata.mimeType.startsWith("application/vnd.google-apps.") && !exportType) {
          throw new Error("This native file type cannot be read");
        }
        const path = exportType
          ? `/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportType)}`
          : `/drive/v3/files/${id}?alt=media&supportsAllDrives=true`;
        const bytes = await request(path, {}, extra.signal);
        const text = !!exportType || metadata.mimeType.startsWith("text/");
        return {
          metadata,
          encoding: text ? "utf-8" : "base64",
          content: text ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString("base64"),
        };
      }),
  );

  server.registerTool(
    "create_text_file",
    {
      description:
        "Upload a new UTF-8 text file to Google Drive. Creates a new file on every call; do not automatically retry after an uncertain result.",
      inputSchema: {
        name: z.string().trim().min(1).max(255),
        text: z.string().max(MAX_BYTES),
        parentId: fileId.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ name, text, parentId }, extra) =>
      result(async () => {
        if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("File too large");
        const boundary = `rakazo-${randomUUID()}`;
        const metadata = {
          name,
          mimeType: "text/plain",
          ...(parentId ? { parents: [parentId] } : {}),
        };
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--\r\n`;
        return json(
          await request(
            `/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=${FILE_FIELDS}`,
            {
              method: "POST",
              headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
              body,
            },
            extra.signal,
          ),
        );
      }),
  );
  return server;
}

export async function runDriveMcpServer() {
  const server = createDriveMcpServer(process.env.ACCESS_TOKEN ?? "");
  await server.connect(new StdioServerTransport());
}
