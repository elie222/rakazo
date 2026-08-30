import { randomInt } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SendBlueEmulator, SendBlueMessagingProvider } from "@rakazo/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describePhone = hasDb ? describe.sequential : describe.skip;

type App = { request: (input: string | Request, init?: RequestInit) => Promise<Response> };

// Offline journeys: injected SendBlueEmulator fetch, no live vendor or paid line.
describePhone("phone surface journeys", () => {
  let app: App;
  let stop: () => Promise<void>;
  let prisma: any;
  const emulator = new SendBlueEmulator();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-phone-"));
  // Unique per run: identities, threads, and outbox rows persist in the dev
  // database. Random E.164 fixtures — a timestamp suffix repeats within
  // hours and collides with earlier runs.
  const stamp = Date.now();
  const uniqueNumber = () => `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;
  const sender = uniqueNumber();
  const dmHandle = `journey-dm-${stamp}`;

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      messaging: new SendBlueMessagingProvider(
        {
          apiKeyId: "emulated",
          apiSecret: "emulated",
          signingSecret: emulator.signingSecret,
          phoneNumber: emulator.phoneNumber,
        },
        { fetch: emulator.fetch },
      ),
      sendblueSigningSecret: emulator.signingSecret,
      sendbluePhoneNumber: emulator.phoneNumber,
    });
    app = handles.app;
    stop = handles.stop;
    prisma = handles.prisma;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("provisions on first text, runs the bot, and mirrors the reply back out", async () => {
    const res = await app.request(
      emulator.buildInboundRequest({
        fromNumber: sender,
        content: "hello there",
        handle: dmHandle,
      }),
    );
    expect(res.status).toBe(200);

    await waitForDatabase(async () =>
      Boolean(await prisma.phoneIdentity.findUnique({ where: { phoneE164: sender } })),
    );
    // A non-null provider handle is the last durable signal of the whole
    // mirror loop (the claim flips status before the provider call lands).
    await waitForDatabase(async () =>
      Boolean(
        await prisma.phoneOutbound.findFirst({
          where: { toNumber: sender, kind: "dm", status: "sent", providerHandle: { not: null } },
        }),
      ),
    );
    expect(emulator.sent.some((send) => send.kind === "dm" && send.to === sender)).toBe(true);

    const identity = await prisma.phoneIdentity.findUnique({ where: { phoneE164: sender } });
    expect(identity.outboundSinceInbound).toBe(1);
    const outbound = await prisma.phoneOutbound.findMany({
      where: { toNumber: sender, kind: "dm" },
    });
    expect(outbound).toHaveLength(1);
    expect(outbound[0].providerHandle).toBeTruthy();

    const userMessage = await prisma.message.findFirst({
      where: {
        threadId: (await prisma.thread.findFirst({ where: { botId: identity.botId } })).id,
        role: "user",
      },
    });
    expect(userMessage.clientNonce).toMatch(/^phone:/);
  });

  it("replays the same handle without a duplicate message or send", async () => {
    const replay = await app.request(
      emulator.buildInboundRequest({
        fromNumber: sender,
        content: "hello there",
        handle: dmHandle,
      }),
    );
    expect(replay.status).toBe(200);

    // Give any erroneous duplicate work a chance to appear.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const identity = await prisma.phoneIdentity.findUnique({ where: { phoneE164: sender } });
    const thread = await prisma.thread.findFirst({ where: { botId: identity.botId } });
    const userMessages = await prisma.message.findMany({
      where: { threadId: thread.id, role: "user" },
    });
    expect(userMessages).toHaveLength(1);
    const outbound = await prisma.phoneOutbound.findMany({
      where: { toNumber: sender, kind: "dm" },
    });
    expect(outbound).toHaveLength(1);
    expect(emulator.sent.filter((send) => send.kind === "dm" && send.to === sender)).toHaveLength(
      1,
    );
  });

  it("runs the channel loop: discovery, invite, intro, YES, fan-out, attributed post", async () => {
    const stranger = uniqueNumber();
    const groupId = `grp-${stamp}`;

    // 1. Discovery: first group message creates the channel, invites the
    // linked sender, and posts one intro for the unlinked stranger.
    const discovery = await app.request(
      emulator.buildInboundRequest({
        fromNumber: sender,
        content: "hey everyone",
        groupId,
        participants: [sender, stranger, emulator.phoneNumber],
        handle: `grp-discover-${stamp}`,
      }),
    );
    expect(discovery.status).toBe(200);

    await waitForDatabase(async () =>
      Boolean(
        await prisma.phoneOutbound.findFirst({
          where: {
            providerGroupId: groupId,
            kind: "intro",
            status: "sent",
            providerHandle: { not: null },
          },
        }),
      ),
    );
    const channel = await prisma.phoneChannel.findUnique({ where: { providerGroupId: groupId } });
    expect(channel).toBeTruthy();
    const members = await prisma.phoneChannelMember.findMany({
      where: { channelId: channel.id },
      orderBy: { phoneE164: "asc" },
    });
    expect(members).toHaveLength(2);
    const senderMember = members.find((m: any) => m.phoneE164 === sender);
    expect(senderMember.status).toBe("invited");
    expect(senderMember.identityId).toBeTruthy();
    const strangerMember = members.find((m: any) => m.phoneE164 === stranger);
    expect(strangerMember.identityId).toBeNull();
    // invite DM went out to the sender, intro went to the group, both once
    expect(
      emulator.sent.filter((send) => send.kind === "group" && send.groupId === groupId),
    ).toHaveLength(1);
    // the invited-only sender's message was not fanned out to any bot
    const identity = await prisma.phoneIdentity.findUnique({ where: { phoneE164: sender } });
    const runsBefore = await prisma.run.count({ where: { botId: identity.botId } });

    // 2. The owner approves by text command.
    const yes = await app.request(
      emulator.buildInboundRequest({
        fromNumber: sender,
        content: "YES",
        handle: `grp-yes-${stamp}`,
      }),
    );
    expect(yes.status).toBe(200);
    await waitForDatabase(async () => {
      const member = await prisma.phoneChannelMember.findUnique({
        where: { channelId_phoneE164: { channelId: channel.id, phoneE164: sender } },
      });
      return member?.status === "approved";
    });

    // 3. The next group message fans out to the approved bot, whose reply
    // is posted back to the group with attribution.
    const second = await app.request(
      emulator.buildInboundRequest({
        fromNumber: sender,
        content: "what do you think?",
        groupId,
        participants: [sender, stranger, emulator.phoneNumber],
        handle: `grp-second-${stamp}`,
      }),
    );
    expect(second.status).toBe(200);

    await waitForDatabase(async () =>
      Boolean(
        await prisma.phoneOutbound.findFirst({
          where: {
            providerGroupId: groupId,
            kind: "group",
            status: "sent",
            providerHandle: { not: null },
          },
        }),
      ),
    );
    const posts = await prisma.phoneOutbound.findMany({
      where: { providerGroupId: groupId, kind: "group", status: "sent" },
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatch(/^Phone's agent: /);
    expect(await prisma.run.count({ where: { botId: identity.botId } })).toBeGreaterThan(
      runsBefore,
    );
  });

  it("rejects a bad signing secret", async () => {
    const intruder = uniqueNumber();
    const request = emulator.buildInboundRequest({
      fromNumber: intruder,
      content: "intruder",
    });
    const res = await app.request(request.url, {
      method: "POST",
      headers: { "content-type": "application/json", "sb-signing-secret": "wrong" },
      body: await request.text(),
    });
    expect(res.status).toBe(401);
    expect(await prisma.phoneIdentity.findUnique({ where: { phoneE164: intruder } })).toBeNull();
  });

  it("declines a channel invite on NO without waking the bot", async () => {
    const owner = uniqueNumber();
    const stranger = uniqueNumber();
    const groupId = `grp-no-${stamp}`;

    const provision = await app.request(
      emulator.buildInboundRequest({
        fromNumber: owner,
        content: "link me",
        handle: `no-dm-${stamp}`,
      }),
    );
    expect(provision.status).toBe(200);
    await waitForDatabase(async () =>
      Boolean(await prisma.phoneIdentity.findUnique({ where: { phoneE164: owner } })),
    );
    const identity = await prisma.phoneIdentity.findUnique({ where: { phoneE164: owner } });
    const runsBefore = await prisma.run.count({ where: { botId: identity.botId } });

    const discovery = await app.request(
      emulator.buildInboundRequest({
        fromNumber: owner,
        content: "group hello",
        groupId,
        participants: [owner, stranger, emulator.phoneNumber],
        handle: `no-discover-${stamp}`,
      }),
    );
    expect(discovery.status).toBe(200);
    const channel = await waitForDatabase(async () =>
      prisma.phoneChannel.findUnique({ where: { providerGroupId: groupId } }),
    );

    const no = await app.request(
      emulator.buildInboundRequest({
        fromNumber: owner,
        content: "NO",
        handle: `no-cmd-${stamp}`,
      }),
    );
    expect(no.status).toBe(200);
    await waitForDatabase(async () => {
      const member = await prisma.phoneChannelMember.findUnique({
        where: { channelId_phoneE164: { channelId: channel.id, phoneE164: owner } },
      });
      return member?.status === "declined";
    });

    const ignored = await app.request(
      emulator.buildInboundRequest({
        fromNumber: owner,
        content: "should not fan out",
        groupId,
        participants: [owner, stranger, emulator.phoneNumber],
        handle: `no-ignored-${stamp}`,
      }),
    );
    expect(ignored.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await prisma.run.count({ where: { botId: identity.botId } })).toBe(runsBefore);
  });

  it("leaves an approved channel on LEAVE and can rejoin via a later invite", async () => {
    const owner = uniqueNumber();
    const stranger = uniqueNumber();
    const groupId = `grp-leave-${stamp}`;

    const provision = await app.request(
      emulator.buildInboundRequest({
        fromNumber: owner,
        content: "link me again",
        handle: `leave-dm-${stamp}`,
      }),
    );
    expect(provision.status).toBe(200);
    await waitForDatabase(async () =>
      Boolean(await prisma.phoneIdentity.findUnique({ where: { phoneE164: owner } })),
    );

    const discovery = await app.request(
      emulator.buildInboundRequest({
        fromNumber: owner,
        content: "group hello",
        groupId,
        participants: [owner, stranger, emulator.phoneNumber],
        handle: `leave-discover-${stamp}`,
      }),
    );
    expect(discovery.status).toBe(200);
    const channel = await waitForDatabase(async () =>
      prisma.phoneChannel.findUnique({ where: { providerGroupId: groupId } }),
    );

    const yes = await app.request(
      emulator.buildInboundRequest({
        fromNumber: owner,
        content: "YES",
        handle: `leave-yes-${stamp}`,
      }),
    );
    expect(yes.status).toBe(200);
    await waitForDatabase(async () => {
      const member = await prisma.phoneChannelMember.findUnique({
        where: { channelId_phoneE164: { channelId: channel.id, phoneE164: owner } },
      });
      return member?.status === "approved";
    });

    const leave = await app.request(
      emulator.buildInboundRequest({
        fromNumber: owner,
        content: "LEAVE",
        handle: `leave-cmd-${stamp}`,
      }),
    );
    expect(leave.status).toBe(200);
    await waitForDatabase(async () => {
      const member = await prisma.phoneChannelMember.findUnique({
        where: { channelId_phoneE164: { channelId: channel.id, phoneE164: owner } },
      });
      return member?.status === "left";
    });

    const rejoin = await app.request(
      emulator.buildInboundRequest({
        fromNumber: owner,
        content: "back again",
        groupId,
        participants: [owner, stranger, emulator.phoneNumber],
        handle: `leave-rejoin-${stamp}`,
      }),
    );
    expect(rejoin.status).toBe(200);
    await waitForDatabase(async () => {
      const member = await prisma.phoneChannelMember.findUnique({
        where: { channelId_phoneE164: { channelId: channel.id, phoneE164: owner } },
      });
      return member?.status === "invited";
    });
  });

  it("marks a mirrored reply failed when the outbound status webhook reports ERROR", async () => {
    const texter = uniqueNumber();
    const handle = `fail-status-dm-${stamp}`;
    const res = await app.request(
      emulator.buildInboundRequest({
        fromNumber: texter,
        content: "please reply",
        handle,
      }),
    );
    expect(res.status).toBe(200);

    const outbound = await waitForDatabase(async () =>
      prisma.phoneOutbound.findFirst({
        where: { toNumber: texter, kind: "dm", status: "sent", providerHandle: { not: null } },
      }),
    );
    expect(outbound.providerHandle).toBeTruthy();

    const status = await app.request(
      emulator.buildStatusRequest({ handle: outbound.providerHandle, status: "ERROR" }),
    );
    expect(status.status).toBe(200);
    await waitForDatabase(async () => {
      const row = await prisma.phoneOutbound.findUnique({ where: { id: outbound.id } });
      return row?.status === "failed";
    });
  });

  it("ignores a nested vendor envelope that is not a flat inbound message", async () => {
    const stranger = uniqueNumber();
    // A mistaken parser that unwraps `data` would treat this as a message and
    // provision. The SendBlue inbound shape is flat; nested envelopes are ignored.
    const res = await app.request("https://rakazo.test/api/v1/phone/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-signing-secret": emulator.signingSecret,
      },
      body: JSON.stringify({
        data: {
          content: "should not provision",
          is_outbound: false,
          status: "RECEIVED",
          message_handle: `envelope-trap-${stamp}`,
          from_number: stranger,
          sendblue_number: emulator.phoneNumber,
          participants: [stranger, emulator.phoneNumber],
        },
      }),
    });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await prisma.phoneIdentity.findUnique({ where: { phoneE164: stranger } })).toBeNull();
  });

  it("reads registered groups through the nested vendor getGroup envelope", async () => {
    const groupId = `grp-envelope-${stamp}`;
    emulator.registerGroup(groupId, {
      name: "Envelope Check",
      participants: ["+15551110001", "+15551110002"],
    });
    const { SendBlueMessagingProvider } = await import("@rakazo/adapters");
    const provider = new SendBlueMessagingProvider(
      {
        apiKeyId: "emulated",
        apiSecret: "emulated",
        signingSecret: emulator.signingSecret,
        phoneNumber: emulator.phoneNumber,
      },
      { fetch: emulator.fetch },
    );
    const group = await provider.getGroup(groupId, {
      operationId: "journey-get-group",
      traceId: "journey-get-group",
      workspaceId: "ws",
      userId: "user",
      signal: AbortSignal.timeout(5_000),
    });
    expect(group).toEqual({
      id: groupId,
      name: "Envelope Check",
      participants: ["+15551110001", "+15551110002"],
    });
  });
});

async function waitForDatabase<T>(pred: () => Promise<T | false | null | undefined>): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    const value = await pred();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for database state");
}
