import { cancelResponseBody } from "@rakazo/core";
import { XMLParser } from "fast-xml-parser";
import { readBoundedText } from "../../../integrations/connector-http.js";

const MAX_DISCOVERY_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_OBJECT_BYTES = 1024 * 1024;
const MAX_CALENDARS = 50;

export interface CalDavAccount {
  /** The CalDAV address the member entered, such as https://caldav.icloud.com. */
  serverUrl: string;
  username: string;
  password: string;
  /** The calendar home found at sign-in, so syncs skip principal discovery. */
  homeUrl?: string;
}

export interface CalDavCalendar {
  url: string;
  name: string;
}

export interface CalDavObject {
  url: string;
  data: string;
}

/** The server refused these credentials. */
export class CalDavAuthError extends Error {
  constructor() {
    super("The calendar server refused the username or app password.");
    this.name = "CalDavAuthError";
  }
}

/** The server answered, but not like a CalDAV server. */
export class CalDavProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalDavProtocolError";
  }
}

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  // Servers often escape the CR of iCalendar line endings as a character reference.
  htmlEntities: true,
  isArray: (name) => ["response", "propstat", "href", "comp"].includes(name),
});

type Node = Record<string, unknown>;

function asNode(value: unknown): Node | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Node) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const node = asNode(value);
  const inner = node?.["#text"];
  return typeof inner === "string" ? inner : undefined;
}

function hrefIn(value: unknown): string | undefined {
  return asArray(asNode(value)?.href).map(text).find(Boolean);
}

/** The successful properties of each response in a multistatus document. */
function multistatus(body: string): { href: string; props: Node }[] {
  let document: unknown;
  try {
    document = parser.parse(body);
  } catch {
    throw new CalDavProtocolError("The calendar server returned unreadable XML.");
  }
  const root = asNode(asNode(document)?.multistatus);
  if (!root) throw new CalDavProtocolError("The calendar server did not return a multistatus.");
  return asArray(root.response).flatMap((response) => {
    const node = asNode(response);
    const href = asArray(node?.href).map(text).find(Boolean);
    if (!node || !href) return [];
    const props: Node = {};
    for (const propstat of asArray(node.propstat)) {
      const stat = asNode(propstat);
      const status = text(stat?.status) ?? "";
      if (!/\s2\d\d\s/u.test(` ${status} `) && status) continue;
      Object.assign(props, asNode(stat?.prop));
    }
    return [{ href, props }];
  });
}

function calendarTime(date: Date) {
  return `${date.toISOString().replace(/[-:]/gu, "").slice(0, 15)}Z`;
}

function escapeXml(value: string) {
  return value.replace(
    /[<>&'"]/gu,
    (character) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character]!,
  );
}

export class CalDavClient {
  constructor(
    private readonly account: CalDavAccount,
    private readonly fetch: (input: URL, init: RequestInit) => Promise<Response>,
  ) {}

  /** Finds the calendar home through the principal, as RFC 6764 section 6 describes. */
  async discoverHome(signal: AbortSignal): Promise<string> {
    const server = new URL(this.account.serverUrl);
    const principal = await this.propfind(
      server,
      0,
      "<d:current-user-principal/>",
      signal,
      MAX_DISCOVERY_BYTES,
    );
    const principalHref = principal
      .map(({ props }) => hrefIn(props["current-user-principal"]))
      .find(Boolean);
    if (!principalHref) {
      throw new CalDavProtocolError("The server did not name a CalDAV principal.");
    }
    const principalUrl = new URL(principalHref, server);
    const home = await this.propfind(
      principalUrl,
      0,
      "<c:calendar-home-set/>",
      signal,
      MAX_DISCOVERY_BYTES,
    );
    const homeHref = home.map(({ props }) => hrefIn(props["calendar-home-set"])).find(Boolean);
    if (!homeHref) throw new CalDavProtocolError("The server did not name a calendar home.");
    return new URL(homeHref, principalUrl).href;
  }

  /** The event calendars in the account's calendar home. */
  async calendars(signal: AbortSignal): Promise<CalDavCalendar[]> {
    const home = new URL(this.account.homeUrl ?? (await this.discoverHome(signal)));
    const rows = await this.propfind(
      home,
      1,
      "<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/>",
      signal,
      MAX_DISCOVERY_BYTES,
    );
    const calendars: CalDavCalendar[] = [];
    for (const { href, props } of rows) {
      const types = asNode(props.resourcetype);
      if (!types || !("calendar" in types)) continue;
      const components = asArray(asNode(props["supported-calendar-component-set"])?.comp);
      // Without the property, a calendar accepts every component type.
      const names = components.map((component) =>
        String(asNode(component)?.name ?? "").toUpperCase(),
      );
      if (components.length && !names.includes("VEVENT")) continue;
      // Each request goes through the same address checks, wherever the server points.
      const url = new URL(href, home);
      calendars.push({ url: url.href, name: text(props.displayname) ?? "" });
      if (calendars.length >= MAX_CALENDARS) break;
    }
    return calendars;
  }

  /** Calendar objects with an instance in the window; recurring ones come back whole. */
  async events(
    calendarUrl: string,
    window: { from: Date; through: Date },
    signal: AbortSignal,
  ): Promise<CalDavObject[]> {
    const url = new URL(calendarUrl);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${escapeXml(calendarTime(window.from))}" end="${escapeXml(calendarTime(window.through))}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
    const rows = multistatus(await this.request(url, "REPORT", 1, body, signal, MAX_REPORT_BYTES));
    return rows.flatMap(({ href, props }) => {
      const data = text(props["calendar-data"]);
      return data ? [{ url: new URL(href, url).href, data }] : [];
    });
  }

  /** One calendar object, or null once it is gone. */
  async object(objectUrl: string, signal: AbortSignal): Promise<string | null> {
    const response = await this.send(new URL(objectUrl), "GET", undefined, undefined, signal);
    if (response.status === 404 || response.status === 410) {
      cancelResponseBody(response);
      return null;
    }
    return this.read(response, MAX_OBJECT_BYTES);
  }

  private async propfind(
    url: URL,
    depth: 0 | 1,
    props: string,
    signal: AbortSignal,
    maxBytes: number,
  ) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${props}</d:prop></d:propfind>`;
    return multistatus(await this.request(url, "PROPFIND", depth, body, signal, maxBytes));
  }

  private async request(
    url: URL,
    method: string,
    depth: 0 | 1,
    body: string,
    signal: AbortSignal,
    maxBytes: number,
  ) {
    return this.read(await this.send(url, method, depth, body, signal), maxBytes);
  }

  private send(
    url: URL,
    method: string,
    depth: 0 | 1 | undefined,
    body: string | undefined,
    signal: AbortSignal,
  ) {
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new CalDavProtocolError("Calendar addresses must use HTTPS.");
    }
    const credentials = Buffer.from(`${this.account.username}:${this.account.password}`).toString(
      "base64",
    );
    return this.fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${credentials}`,
        ...(depth === undefined ? {} : { Depth: String(depth) }),
        ...(body === undefined
          ? { Accept: "text/calendar" }
          : { "Content-Type": "application/xml; charset=utf-8" }),
      },
      body,
      redirect: "manual",
      signal,
    });
  }

  private async read(response: Response, maxBytes: number) {
    if (response.status === 401 || response.status === 403) {
      cancelResponseBody(response);
      throw new CalDavAuthError();
    }
    if (!response.ok) {
      cancelResponseBody(response);
      throw new Error(`Calendar server returned HTTP ${response.status}.`);
    }
    const { text: body, truncated } = await readBoundedText(response, maxBytes);
    if (truncated) throw new CalDavProtocolError("The calendar server returned too much data.");
    return body;
  }
}
