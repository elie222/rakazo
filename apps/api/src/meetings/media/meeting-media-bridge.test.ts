import { MEETING_MEDIA_PATH } from "@rakazo/adapters/meeting-media";
import { deferred } from "@rakazo/core/test-async";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { MAX_MEETING_AUDIO_BYTES, MEETING_SAMPLE_RATE } from "./meeting-audio.js";
import {
  createMeetingMediaEmulator,
  DEMO_MEDIA_SESSION,
  meetingTone,
} from "./meeting-media.test-support.js";

function fixture() {
  const emulator = createMeetingMediaEmulator("https://rakazo.example.test");
  const app = new Hono();
  emulator.bridge.mount(app);
  const token = new URL(emulator.url()).hash.slice(1);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" };
  return {
    emulator,
    app,
    headers,
    turn: (body = new Uint8Array(meetingTone(MEETING_SAMPLE_RATE / 2)), signal?: AbortSignal) =>
      app.request(`${MEETING_MEDIA_PATH}/turn`, { method: "POST", headers, body, signal }),
    session: (authorization = headers.authorization) =>
      app.request(`${MEETING_MEDIA_PATH}/session`, { headers: { authorization } }),
  };
}

describe("meeting media bridge", () => {
  it("authenticates the camera page, sends microphone samples as WAV and returns a playable reply", async () => {
    const { emulator, app, session, turn } = fixture();
    const page = await app.request(MEETING_MEDIA_PATH);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await page.text()).toContain('alt="Rakazo"');
    expect(await (await session()).json()).toEqual({ botName: "Atlas", voice: true });

    const response = await turn();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.from(await response.arrayBuffer()).readUInt32LE(24)).toBe(MEETING_SAMPLE_RATE);
    expect(emulator.received).toHaveLength(1);
    // One start check and one paid-turn check. The post-turn ACL has no credential lookup.
    expect(emulator.readinessChecks).toBe(2);
    const recorded = Buffer.from(emulator.received[0]!);
    expect(recorded.toString("ascii", 0, 4)).toBe("RIFF");
    expect(recorded.readUInt32LE(40)).toBe(MEETING_SAMPLE_RATE);
    expect(recorded.subarray(44)).toEqual(meetingTone(MEETING_SAMPLE_RATE / 2));
  });

  it("refuses missing, expired, tampered and differently scoped session grants", async () => {
    const { emulator, app, session, headers } = fixture();
    const [id, expiry, signature] = headers.authorization.slice(7).split(".");
    const expired = new URL(emulator.bridge.pageUrl(DEMO_MEDIA_SESSION, new Date(0))).hash.slice(1);
    expect((await session("")).status).toBe(401);
    expect((await session(`Bearer ${id}.${expiry}.${signature?.slice(0, -1)}!`)).status).toBe(401);
    expect((await session(`Bearer other-session.${expiry}.${signature}`)).status).toBe(401);
    expect((await session(`Bearer ${expired}`)).status).toBe(401);
    expect((await app.request(`${MEETING_MEDIA_PATH}/turn`, { method: "POST" })).status).toBe(401);
    expect(emulator.received).toHaveLength(0);
  });

  it("gates voice on admission, bounds capture size, and can return silence", async () => {
    const { emulator, turn } = fixture();
    emulator.session.admitted = false;
    expect((await turn()).status).toBe(204);
    expect(emulator.received).toHaveLength(0);

    emulator.session.admitted = true;
    expect((await turn(new Uint8Array(MAX_MEETING_AUDIO_BYTES + 2))).status).toBe(413);
    expect((await turn(new Uint8Array(3))).status).toBe(400);
    emulator.setSilent(true);
    expect((await turn()).status).toBe(204);
    expect(emulator.received).toHaveLength(1);
  });

  it("keeps the camera branded while blocking capture and paid turns when voice becomes unavailable", async () => {
    const { emulator, session, turn } = fixture();
    emulator.setVoiceAvailable(false);

    expect(await (await session()).json()).toEqual({ botName: "Atlas", voice: false });
    expect((await turn()).status).toBe(403);
    expect(emulator.received).toHaveLength(0);
  });

  it("treats an interrupted request as a silent result", async () => {
    const { emulator, turn } = fixture();
    const controller = new AbortController();
    const reply = deferred<void>();
    emulator.beforeReply(() => reply.promise);
    const pending = turn(undefined, controller.signal);
    await expect.poll(() => emulator.received.length).toBe(1);
    controller.abort();
    reply.resolve();
    expect((await pending).status).toBe(204);
  });

  it("drops a queued spoken reply when leave revokes the session", async () => {
    const { emulator, turn } = fixture();
    const reply = deferred<void>();
    emulator.beforeReply(() => reply.promise);
    const pending = turn();
    await expect.poll(() => emulator.received.length).toBe(1);
    emulator.revoke();
    reply.resolve();
    expect((await pending).status).toBe(401);
    expect((await turn()).status).toBe(401);
  });
});
