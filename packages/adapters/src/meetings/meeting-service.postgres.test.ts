import { randomUUID } from "node:crypto";
import { createDb, createThreadEvents, runAsSystem, runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { MeetingEmulator } from "../providers/meeting/emulator/meeting-emulator.js";
import { GraphileJobPublisher } from "../runs/wakeups/wakeup.js";
import { MeetingService } from "./meeting-service.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;

describe.skipIf(!databaseUrl)("meeting transcript recovery in PostgreSQL", () => {
  it("commits a pending transcript and its Graphile backup together", async () => {
    const { prisma, pool } = createDb(databaseUrl!);
    const jobs = new GraphileJobPublisher(pool);
    const provider = new MeetingEmulator();
    const request = vi
      .spyOn(provider, "requestTranscript")
      .mockImplementation(async (recordingId) => ({
        id: `transcript-${recordingId}`,
        ready: false,
      }));
    const events = createThreadEvents(prisma);
    const service = new MeetingService({ prisma, jobs, provider, events });
    const organizationId = randomUUID();
    const userId = randomUUID();
    const spaceId = randomUUID();
    const botId = randomUUID();
    const email = "fixture@meeting.example.test";
    const actor = { userId, spaceId, email, isDeploymentOwner: false };
    try {
      await runAsSystem("seed meeting recovery fixture", async () => {
        const now = new Date();
        await prisma.user.create({ data: { id: userId, email, name: "Fixture" } });
        await prisma.organization.create({
          data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: now },
        });
        await prisma.space.create({ data: { id: spaceId, organizationId, name: "Fixture" } });
        await prisma.member.create({
          data: { id: randomUUID(), organizationId, userId, role: "owner", createdAt: now },
        });
        await prisma.spaceMember.create({
          data: {
            id: randomUUID(),
            organizationId,
            userId,
            spaceId,
            role: "owner",
            createdAt: now,
          },
        });
        await prisma.bot.create({
          data: { id: botId, userId, spaceId, color: "ink", name: "Atlas" },
        });
      });
      await runAsTenant(actor, async () => {
        await service.join(actor, botId, "https://meet.google.com/abc-defg-hij");
        const { meetings } = await service.list(actor, botId);
        const sessionId = meetings[0]!.id;
        await service.leave(actor, sessionId);
        const pending = await prisma.meetingSession.findUniqueOrThrow({ where: { id: sessionId } });
        expect(pending.transcriptId).toBe(`transcript-recording-${sessionId}`);
        expect(pending.status).toBe("processing");

        request.mockImplementation(async (recordingId) => ({
          id: `transcript-${recordingId}`,
          ready: true,
        }));
        // A completion webhook is optional once Graphile holds the deadline check.
        await service.work({ sessionId, action: "transcript-check" });
        const result = await service.transcript(actor, sessionId);
        expect(result.turns[0]?.speaker).toBe("Alex Rivera");
      });
    } finally {
      await jobs.close();
      await pool.end();
    }
  });
});
