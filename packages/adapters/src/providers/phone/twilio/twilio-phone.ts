import type {
  AdapterContext,
  AdapterDescriptor,
  PhoneNetworkCallRequest,
  PhoneNetworkCallResult,
  PhoneNetworkCapabilities,
  PhoneNetworkProvider,
  PhoneNetworkVerifyResult,
} from "@rakazo/adapter-kit";
import { normalizePhoneNumber } from "@rakazo/adapter-kit";
import { deadlineSignal } from "@rakazo/core";

const API = "https://api.twilio.com/2010-04-01";

export type TwilioPhoneConfig = {
  /** The Twilio Account SID, for example "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx". */
  accountSid: string;
  /** The Account Auth Token used for HTTP Basic authentication. */
  authToken: string;
  /** The Twilio caller id the calls are placed from, in E.164 form. */
  fromNumber: string;
};

/** The HTTP seam the adapter talks through, so tests never reach the network. */
export type TwilioPhoneTransport = (input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ status: number; body: string }>;

function basicAuth(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`, "utf8").toString("base64")}`;
}

/** The default transport: a real form-encoded POST against the Twilio REST API. */
export const twilioPhoneTransport: TwilioPhoneTransport = async (input) => {
  const res = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
    signal: input.signal ?? AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: await res.text() };
};

/** Builds the form-encoded body Twilio expects for a call request. */
export function twilioCallForm(request: PhoneNetworkCallRequest, from: string): string {
  const fields: Array<[string, string | undefined]> = [
    ["To", request.to],
    ["From", from],
    ["Timeout", request.timeoutSeconds === undefined ? undefined : String(request.timeoutSeconds)],
  ];
  return fields
    .filter((field): field is [string, string] => field[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/** Reads the call id and status out of a Twilio call response. */
export function parseTwilioCallResponse(body: unknown): { callId: string; status: string } {
  const record = (body ?? {}) as { sid?: unknown; status?: unknown };
  const callId = typeof record.sid === "string" ? record.sid.trim() : "";
  const status = typeof record.status === "string" ? record.status.trim() : "";
  if (!callId) throw new Error("Twilio did not return a call id.");
  if (!status) throw new Error("Twilio did not return a call status.");
  return { callId, status };
}

/** Turns a Twilio error payload into a message that names the reason and the code. */
export function twilioErrorMessage(status: number, body: unknown): string {
  const record = (body ?? {}) as { message?: unknown; code?: unknown };
  const message = typeof record.message === "string" ? record.message.trim() : "";
  const code = record.code === undefined || record.code === null ? "" : String(record.code).trim();
  if (message && code) return `${message} (code ${code})`;
  if (message) return message;
  if (code) return `Twilio error ${code}`;
  return `Twilio returned ${status}.`;
}

export class TwilioPhoneProvider implements PhoneNetworkProvider {
  constructor(
    private readonly config: TwilioPhoneConfig,
    private readonly transport: TwilioPhoneTransport = twilioPhoneTransport,
  ) {}

  describe(): AdapterDescriptor<PhoneNetworkCapabilities> {
    return {
      id: "twilio",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { call: true },
    };
  }

  /**
   * Checks the operator's credentials against the account endpoint.
   *
   * The `apiKey` argument overrides the configured auth token so the Settings
   * API-key flow works; the Account SID always comes from the configuration.
   * This never throws: a failure comes back as a message.
   */
  async verify(apiKey: string, context: AdapterContext): Promise<PhoneNetworkVerifyResult> {
    const authToken = apiKey.trim() || this.config.authToken;
    try {
      const res = await this.transport({
        url: `${API}/Accounts/${this.config.accountSid}.json`,
        method: "GET",
        headers: { Authorization: basicAuth(this.config.accountSid, authToken) },
        body: "",
        signal: deadlineSignal(15_000, context.signal),
      });
      if (res.status === 200) return { ok: true };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: "Twilio rejected these credentials." };
      }
      return { ok: false, message: `Twilio returned ${res.status}.` };
    } catch {
      return { ok: false, message: "Could not reach Twilio." };
    }
  }

  /** Places an outbound call to an E.164 number. */
  async placeCall(
    request: PhoneNetworkCallRequest,
    context: AdapterContext,
  ): Promise<PhoneNetworkCallResult> {
    const to = normalizePhoneNumber(request.to);
    if (!to) throw new Error("The destination number is not a valid E.164 phone number.");
    const from = request.from ? normalizePhoneNumber(request.from) : this.config.fromNumber;
    if (!from) throw new Error("The caller id is not a valid E.164 phone number.");

    const res = await this.transport({
      url: `${API}/Accounts/${this.config.accountSid}/Calls.json`,
      method: "POST",
      headers: {
        Authorization: basicAuth(this.config.accountSid, this.config.authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: twilioCallForm({ ...request, to }, from),
      signal: deadlineSignal(15_000, context.signal),
    });

    const parsed = parseJson(res.body);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Twilio refused the call: ${twilioErrorMessage(res.status, parsed)}`);
    }
    const { callId, status } = parseTwilioCallResponse(parsed);
    return { callId, status, to, from };
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export const twilioPhone = {
  name: "Twilio",
  description: "Places real outbound calls on the public telephone network.",
  call: true,
};
