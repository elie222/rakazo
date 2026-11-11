import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  ConnectedConnector,
  ConnectedMailMessage,
  ConnectedMailPage,
  ConnectedMailReader,
  ConnectedMailSource,
  ConnectorProvider,
} from "@rakazo/adapter-kit";

/**
 * The only tools the reader calls: its grant also allows sending and changing mail, so the tool
 * names are listed here and tested, and nothing else goes out.
 */
export const CONNECTED_MAIL_READ_TOOLS = [
  "GMAIL_GET_PROFILE",
  "GMAIL_FETCH_EMAILS",
  "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
] as const;

type ReadTool = (typeof CONNECTED_MAIL_READ_TOOLS)[number];

/** Reads a Gmail mailbox connected through Composio, through the registry that authorizes it. */
class ComposioMailReader implements ConnectedMailReader {
  constructor(
    private readonly connector: Pick<ConnectorProvider, "execute">,
    private readonly connection: ConnectedConnector,
  ) {}

  async mailbox(context: AdapterContext): Promise<string> {
    const profile = await this.call(context, "GMAIL_GET_PROFILE", {});
    const address = stringAt(profile, "emailAddress");
    if (!address) throw new Error("The mailbox's address was not in the profile");
    return address.toLowerCase();
  }

  async recent(
    context: AdapterContext,
    query: { fromDomain: string; after: Date; limit: number; page?: string },
  ): Promise<ConnectedMailPage> {
    const listed = await this.call(context, "GMAIL_FETCH_EMAILS", {
      query: `from:${query.fromDomain} after:${epochSeconds(query.after)}`,
      max_results: query.limit,
      ids_only: true,
      ...(query.page ? { page_token: query.page } : {}),
    });
    const messages: ConnectedMailMessage[] = [];
    const ids = messageIds(listed);
    // The page past the limit would be left unread, and the next page starts after it.
    if (ids.length > query.limit) throw new Error("The mail listing has more messages than asked");
    for (const id of ids) {
      // Between raw reads too: once the look gave up or timed out, no further message is read.
      context.signal.throwIfAborted();
      const read = await this.call(context, "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
        message_id: id,
        format: "raw",
      });
      const raw = stringAt(read, "raw");
      // A listed message that cannot be read may hold the newest code: the whole read fails,
      // so the card opens, rather than the other messages answering in its place.
      if (!raw) throw new Error("A listed message cannot be read in its raw form");
      const stamp = valueAt(read, "internalDate");
      const received =
        typeof stamp === "string" || typeof stamp === "number" ? Number(stamp) : Number.NaN;
      messages.push({
        id,
        raw: new Uint8Array(Buffer.from(raw, "base64")),
        ...(Number.isFinite(received) ? { receivedAt: new Date(received) } : {}),
      });
    }
    const next = stringAt(listed, "nextPageToken");
    return next ? { messages, next } : { messages };
  }

  /** The tool's result data, or the error it ended with. */
  private async call(
    context: AdapterContext,
    tool: ReadTool,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    let data: unknown;
    let failure: string | undefined;
    const call = {
      tool,
      args,
      // Each call is its own execution to the connector, across the looks one request makes.
      executionId: `${context.operationId}:${tool}:${randomUUID()}`,
      route: {
        connectorId: this.connection.connectorId,
        toolName: tool,
        connectionId: this.connection.id,
      },
    };
    // The look gave up or timed out: no further call goes out, and leaving the loop ends this one.
    context.signal.throwIfAborted();
    for await (const event of this.connector.execute(call, context)) {
      context.signal.throwIfAborted();
      if (event.type === "result") data = event.data;
      else if (event.type === "error") failure = event.message;
    }
    if (failure) throw new Error(failure);
    // The connector wraps the tool's own output under `data`; a failed call says so there.
    const result = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    if (result.isError === true || result.error != null) throw new Error(`${tool} failed`);
    return result.data;
  }
}

/** The mail reader for connections the Composio connector serves; none for any other. */
export function composioMailSource(
  connector: Pick<ConnectorProvider, "execute">,
): ConnectedMailSource {
  return {
    readerFor(connection) {
      return connection.connectorId === "composio" &&
        connection.externalId.trim().toLowerCase() === "gmail"
        ? new ComposioMailReader(connector, connection)
        : undefined;
    },
  };
}

/**
 * The instant as whole seconds since the epoch, which the provider's `after:` takes exactly; a
 * `YYYY/MM/DD` day would be read on the mailbox's own clock and could start after the window.
 */
function epochSeconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

/** The value under `key`, in the value itself or one level in, as the provider wraps results. */
function valueAt(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const direct = (value as Record<string, unknown>)[key];
  if (direct !== undefined) return direct;
  for (const inner of Object.values(value)) {
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) continue;
    const found = (inner as Record<string, unknown>)[key];
    if (found !== undefined) return found;
  }
  return undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  const found = valueAt(value, key);
  return typeof found === "string" ? found : undefined;
}

/**
 * Message ids from a listing, however the provider wraps it. A listing without `messages` says
 * there is no mail; one in any other shape, or with a message without an id, cannot be read and
 * fails the read, as what it holds may be the newest code: the card opens instead.
 */
function messageIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The mail listing cannot be read");
  const list = valueAt(value, "messages");
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error("The mail listing cannot be read");
  const ids: string[] = [];
  for (const item of list) {
    const id = stringAt(item, "messageId") ?? stringAt(item, "id");
    if (!id) throw new Error("A listed message has no id");
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
