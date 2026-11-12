import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  ConnectedConnector,
  ConnectedMailListing,
  ConnectedMailPage,
  ConnectedMailReader,
  ConnectedMailSource,
  ConnectorProvider,
} from "@rakazo/adapter-kit";
import { pinnedAccountId } from "./composio-connector.js";

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
    // The search names messages and nothing more. It fetches none, sizes none and refuses none:
    // whatever the provider matches, from whichever sender and however large, the listing goes
    // on to tell of each, and which of them may be the site's is the caller's to judge.
    const names = { ids_only: true, max_results: query.limit };
    const listed = await this.call(context, "GMAIL_FETCH_EMAILS", {
      ...names,
      query: `from:${query.fromDomain} after:${epochSeconds(query.after)}`,
      ...(query.page ? { page_token: query.page } : {}),
    });
    const ids = messageIds(listed);
    // The page past the limit would be left unread, and the next page starts after it.
    if (ids.length > query.limit) throw new Error("The mail listing has more messages than asked");
    // Its headers and size only: the search is loose, so who sent a message and how large it is
    // are learned before any of its content is fetched. The page's messages are asked about
    // together, so mail the search matched from other senders costs the look one call's time a
    // page, not one each. Each call checks first that the look has not given up or timed out.
    const messages = await Promise.all(
      ids.map(async (id): Promise<ConnectedMailListing> => {
        const told = await this.call(context, "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
          message_id: id,
          format: "metadata",
        });
        const from = senderAddress(told);
        const size = numberAt(told, "sizeEstimate");
        const received = numberAt(told, "internalDate");
        return {
          id,
          ...(from ? { from } : {}),
          ...(Number.isFinite(size) ? { size } : {}),
          ...(Number.isFinite(received) ? { receivedAt: new Date(received) } : {}),
        };
      }),
    );
    const next = stringAt(listed, "nextPageToken");
    return next ? { messages, next } : { messages };
  }

  async read(context: AdapterContext, id: string, maxBytes: number): Promise<Uint8Array> {
    const read = await this.call(context, "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
      message_id: id,
      format: "raw",
    });
    const raw = stringAt(read, "raw");
    if (!raw) throw new Error("A listed message cannot be read in its raw form");
    // Held to the limit by its encoded length, before it is decoded, whatever size was reported.
    if (Buffer.byteLength(raw, "base64") > maxBytes)
      throw new Error("A listed message is larger than the read may hold");
    return new Uint8Array(Buffer.from(raw, "base64"));
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

/**
 * The mail reader for a Gmail connection the Composio connector serves that names one account
 * of the provider; none for any other. A connection that names no account (a legacy row) gets
 * no reader: the connector could not hold its calls to one account, and the provider would
 * read whichever mailbox of the user it picks, also one that was never connected in the Space.
 */
export function composioMailSource(
  connector: Pick<ConnectorProvider, "execute">,
): ConnectedMailSource {
  return {
    readerFor(connection) {
      return connection.connectorId === "composio" &&
        connection.externalId.trim().toLowerCase() === "gmail" &&
        pinnedAccountId(connection) !== undefined
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

/** The number under `key`, also when the provider writes it as text; NaN when it is neither. */
function numberAt(value: unknown, key: string): number {
  const found = valueAt(value, key);
  return typeof found === "number" || (typeof found === "string" && found.trim() !== "")
    ? Number(found)
    : Number.NaN;
}

/**
 * The one address a message's metadata names as its sender, lowercased: its From header where
 * the provider hands the headers over, else the sender it reports. Nothing when neither is
 * there, or when what is there is anything but one plain address, alone or after a name that
 * holds no other: a caller that rules a message out by its sender must never be told one a
 * mail parser could read otherwise, so it treats such a message as possibly anyone's.
 */
function senderAddress(told: unknown): string | undefined {
  const headers = valueAt(valueAt(told, "payload"), "headers");
  const from = Array.isArray(headers)
    ? headers.flatMap((header) =>
        stringAt(header, "name")?.toLowerCase() === "from" ? [stringAt(header, "value")] : [],
      )
    : [stringAt(told, "sender")];
  const [written] = from;
  if (from.length !== 1 || !written || written.split("@").length !== 2) return undefined;
  // "Name <address>" or the address alone; anything else is not read as one sender.
  const address = (written.match(/<([^<>]*)>\s*$/)?.[1] ?? written).trim().toLowerCase();
  return /^[^\s@,;<>"()]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(address) ? address : undefined;
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
