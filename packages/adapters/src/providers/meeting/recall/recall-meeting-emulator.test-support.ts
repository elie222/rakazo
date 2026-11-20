import { createHmac } from "node:crypto";

export const BOT_ID = "6519d6a7-e46f-4ab0-83a6-6539700c2c4a";
export const RECORDING_ID = "c269ffca-e8ee-4be7-97bf-e8dbb5f3f83b";
export const TRANSCRIPT_ID = "134ef560-d7a4-42c6-b3f4-863870145861";
const downloadUrl = "https://recording-files.example.s3.amazonaws.com/demo.json";
const signingKey = Buffer.from("fake-meeting-emulator-signing-key");
export const webhookSecret = `whsec_${signingKey.toString("base64")}`;

export function signedMeetingEvent(value: unknown, prefix = "webhook") {
  const raw = JSON.stringify(value);
  const id = "example-delivery";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const digest = createHmac("sha256", signingKey)
    .update(`${id}.${timestamp}.${raw}`)
    .digest("base64");
  return {
    raw,
    headers: new Headers({
      [`${prefix}-id`]: id,
      [`${prefix}-timestamp`]: timestamp,
      [`${prefix}-signature`]: `v1,${digest}`,
    }),
  };
}

export class RecallMeetingEmulator {
  requests: Array<{ method: string; path: string; body: unknown }> = [];
  joinStatus = 201;
  private bot: { id: string; metadata: object } | undefined;
  private artifact = false;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path: url.pathname, body });
    if (url.href === downloadUrl) {
      if (new Headers(init?.headers).has("authorization"))
        return new Response(null, { status: 403 });
      return Response.json([
        {
          participant: { name: "Alex Rivera" },
          words: [{ text: "Friday.", start_timestamp: { relative: 2.6 } }],
        },
        {
          participant: { name: "Sam Chen" },
          words: [{ text: "Yes.", start_timestamp: { relative: 1.1 } }],
        },
      ]);
    }
    if (new Headers(init?.headers).get("authorization") !== "Token fake-key") {
      return new Response(null, { status: 401 });
    }
    if (url.pathname === "/api/v1/bot/" && method === "POST") {
      if (this.joinStatus !== 201) {
        return new Response(null, { status: this.joinStatus, headers: { "retry-after": "30" } });
      }
      this.bot = { id: BOT_ID, metadata: body.metadata };
      return Response.json(this.bot, { status: 201 });
    }
    if (url.pathname === "/api/v1/bot/") {
      return Response.json({ results: this.bot ? [this.bot] : [] });
    }
    if (url.pathname === `/api/v1/bot/${BOT_ID}/leave_call/`) {
      return new Response(null, { status: 200 });
    }
    if (url.pathname === `/api/v1/recording/${RECORDING_ID}/create_transcript/`) {
      this.artifact = true;
      return Response.json({ id: TRANSCRIPT_ID, status: { code: "processing" } });
    }
    if (url.pathname === "/api/v1/transcript/") {
      return Response.json({
        results: this.artifact ? [{ id: TRANSCRIPT_ID, status: { code: "done" } }] : [],
      });
    }
    if (url.pathname === `/api/v1/transcript/${TRANSCRIPT_ID}/` && this.artifact) {
      return Response.json({ id: TRANSCRIPT_ID, data: { download_url: downloadUrl } });
    }
    if (url.pathname === `/api/v1/recording/${RECORDING_ID}/` && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  };
}
