import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import type { TwilioPhoneTransport } from "./twilio-phone.js";
import {
  parseTwilioCallResponse,
  TwilioPhoneProvider,
  twilioCallForm,
  twilioErrorMessage,
} from "./twilio-phone.js";

const context: AdapterContext = {
  operationId: "test-operation",
  traceId: "test-trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

const config = {
  accountSid: "ACxxxx",
  authToken: "auth-token",
  fromNumber: "+14155550100",
};

type Recorded = { url: string; method: string; headers: Record<string, string>; body: string };

function recordingTransport(reply: { status: number; body: string }): {
  transport: TwilioPhoneTransport;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const transport: TwilioPhoneTransport = async (input) => {
    calls.push(input);
    return reply;
  };
  return { transport, calls };
}

describe("Twilio phone provider", () => {
  it("describes itself as a call provider", () => {
    const descriptor = new TwilioPhoneProvider(config).describe();
    expect(descriptor.id).toBe("twilio");
    expect(descriptor.capabilities.call).toBe(true);
  });

  it("verifies credentials against the account endpoint", async () => {
    const { transport, calls } = recordingTransport({ status: 200, body: "{}" });
    const result = await new TwilioPhoneProvider(config, transport).verify("key", context);
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACxxxx.json");
    expect(calls[0]?.headers.Authorization).toMatch(/^Basic /);
  });

  it("reports rejected credentials without throwing", async () => {
    const { transport } = recordingTransport({ status: 401, body: "{}" });
    const result = await new TwilioPhoneProvider(config, transport).verify("key", context);
    expect(result.ok).toBe(false);
  });

  it("reports an unreachable provider without throwing", async () => {
    const transport: TwilioPhoneTransport = async () => {
      throw new Error("network down");
    };
    const result = await new TwilioPhoneProvider(config, transport).verify("key", context);
    expect(result.ok).toBe(false);
  });

  it("places a call with the destination and the configured caller id", async () => {
    const { transport, calls } = recordingTransport({
      status: 201,
      body: JSON.stringify({ sid: "CAxxxx", status: "queued" }),
    });
    const result = await new TwilioPhoneProvider(config, transport).placeCall(
      { to: "+14155550123" },
      context,
    );
    expect(result).toEqual({
      callId: "CAxxxx",
      status: "queued",
      to: "+14155550123",
      from: "+14155550100",
    });
    expect(calls[0]?.url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACxxxx/Calls.json");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toContain("To=%2B14155550123");
    expect(calls[0]?.body).toContain("From=%2B14155550100");
  });

  it("rejects a destination that is not a valid E.164 number before calling Twilio", async () => {
    const { transport, calls } = recordingTransport({ status: 201, body: "{}" });
    await expect(
      new TwilioPhoneProvider(config, transport).placeCall({ to: "415-555-0123" }, context),
    ).rejects.toThrow(/not a valid E.164/);
    expect(calls).toHaveLength(0);
  });

  it("sends the normalized destination to Twilio", async () => {
    const { transport, calls } = recordingTransport({
      status: 201,
      body: JSON.stringify({ sid: "CAxxxx", status: "queued" }),
    });
    await new TwilioPhoneProvider(config, transport).placeCall(
      { to: "+1 (415) 555-0123" },
      context,
    );
    expect(calls[0]?.body).toContain("To=%2B14155550123");
  });

  it("reports the provider's reason when Twilio refuses the call", async () => {
    const { transport } = recordingTransport({
      status: 400,
      body: JSON.stringify({ code: 21211, message: "To is not a valid phone number" }),
    });
    await expect(
      new TwilioPhoneProvider(config, transport).placeCall({ to: "+14155550123" }, context),
    ).rejects.toThrow(/To is not a valid phone number/);
  });
});

describe("Twilio helpers", () => {
  it("builds a form body and leaves out the fields that were not given", () => {
    expect(twilioCallForm({ to: "+14155550123" }, "+14155550100")).toBe(
      "To=%2B14155550123&From=%2B14155550100",
    );
    expect(twilioCallForm({ to: "+14155550123", timeoutSeconds: 30 }, "+14155550100")).toContain(
      "Timeout=30",
    );
  });

  it("reads the call id and the status out of a response", () => {
    expect(parseTwilioCallResponse({ sid: "CAxxxx", status: "ringing" })).toEqual({
      callId: "CAxxxx",
      status: "ringing",
    });
    expect(() => parseTwilioCallResponse({ status: "ringing" })).toThrow(/call id/i);
    expect(() => parseTwilioCallResponse({ sid: "CAxxxx" })).toThrow(/status/i);
  });

  it("names the message and the code of a Twilio error", () => {
    expect(
      twilioErrorMessage(400, { code: 21211, message: "To is not a valid phone number" }),
    ).toBe("To is not a valid phone number (code 21211)");
    expect(twilioErrorMessage(500, {})).toBe("Twilio returned 500.");
  });
});
