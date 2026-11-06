import { setTimeout as sleep } from "node:timers/promises";
import { attachmentComputerPath } from "@rakazo/core";
import { z } from "zod";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

/** Longest a read_email call waits for mail to arrive, well inside a run's lease renewal. */
export const READ_EMAIL_MAX_WAIT_SECONDS = 120;
/** Body text one read returns; a longer email continues from nextTextOffset. */
const TEXT_PAGE_CHARS = 8_000;
const PREVIEW_CHARS = 160;
const POLL_MS = 3_000;
/** Emails one delete_email call removes. */
const DELETE_EMAIL_MAX_IDS = 50;

const ReadEmailSchema = z
  .object({
    id: z.string().trim().min(1).max(100).optional(),
    query: z.string().trim().max(200).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    waitSeconds: z.number().int().min(0).max(READ_EMAIL_MAX_WAIT_SECONDS).optional(),
    textOffset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

const DeleteEmailSchema = z
  .object({
    ids: z.array(z.string().trim().min(1).max(100)).min(1).max(DELETE_EMAIL_MAX_IDS),
  })
  .strict();

type SavedFile = { name: string; artifactId?: string; mimeType?: string; size?: number };

async function readEmail(ctx: RunContext, call: ToolCall) {
  const parsed = ReadEmailSchema.safeParse(call.args);
  if (!parsed.success) {
    return call.finish({
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join(" "),
    });
  }
  const input = parsed.data;
  const { deps, bot, run } = ctx;
  // The inbox is the owner's mail: only their own runs of their own bot read it.
  if (run.userId !== bot.userId) return call.finish({ error: "Only the bot's owner can do that." });

  if (input.id) {
    const email = await deps.prisma.botEmailMessage.findFirst({
      where: { id: input.id, botId: bot.id },
    });
    if (!email) return call.finish({ error: "No email with that id in your inbox." });
    const offset = input.textOffset ?? 0;
    const text = email.text.slice(offset, offset + TEXT_PAGE_CHARS);
    const files = email.attachments as SavedFile[];
    const kept = files.flatMap((file) =>
      file.artifactId && file.mimeType
        ? [
            {
              kind: "file" as const,
              artifactId: file.artifactId,
              name: file.name,
              mimeType: file.mimeType,
              size: file.size ?? 0,
            },
          ]
        : [],
    );
    // Copied before the bot's next computer tool, where history tools put files too.
    ctx.computer.copyEarlierFiles(kept);
    return call.finish({
      untrusted: true,
      email: {
        id: email.id,
        from: email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress,
        verified: email.verified,
        to: email.to,
        ...(email.cc.length ? { cc: email.cc } : {}),
        subject: email.subject,
        receivedAt: email.receivedAt.toISOString(),
        text,
        ...(offset + TEXT_PAGE_CHARS < email.text.length
          ? { nextTextOffset: offset + TEXT_PAGE_CHARS }
          : {}),
        ...(files.length
          ? {
              files: files.map((file) =>
                file.artifactId && file.mimeType
                  ? {
                      name: file.name,
                      path: attachmentComputerPath(file.artifactId, file.mimeType),
                    }
                  : { name: file.name, unavailable: true },
              ),
            }
          : {}),
      },
    });
  }

  const startedAt = new Date();
  const where = {
    botId: bot.id,
    ...(input.since ? { receivedAt: { gt: new Date(input.since) } } : {}),
    ...(input.query
      ? {
          OR: (["fromAddress", "fromName", "subject", "text"] as const).map((field) => ({
            [field]: { contains: input.query, mode: "insensitive" as const },
          })),
        }
      : {}),
  };
  const list = () =>
    deps.prisma.botEmailMessage.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      take: input.limit ?? 10,
      select: {
        id: true,
        fromAddress: true,
        fromName: true,
        verified: true,
        subject: true,
        receivedAt: true,
        text: true,
        attachments: true,
      },
    });
  let emails = await list();
  const deadline = startedAt.getTime() + (input.waitSeconds ?? 0) * 1000;
  // The last look lands on the deadline, so a wait shorter than one poll still waits.
  for (
    let left = deadline - Date.now();
    emails.length === 0 && left > 0;
    left = deadline - Date.now()
  ) {
    await sleep(Math.min(POLL_MS, left), undefined, { signal: ctx.context.signal });
    emails = await list();
  }
  return call.finish({
    untrusted: true,
    now: startedAt.toISOString(),
    emails: emails.map((email) => ({
      id: email.id,
      from: email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress,
      verified: email.verified,
      subject: email.subject,
      receivedAt: email.receivedAt.toISOString(),
      preview: email.text.slice(0, PREVIEW_CHARS).replace(/\s+/g, " ").trim(),
      ...((email.attachments as SavedFile[]).length
        ? { files: (email.attachments as SavedFile[]).length }
        : {}),
    })),
  });
}

async function deleteEmail(ctx: RunContext, call: ToolCall) {
  const parsed = DeleteEmailSchema.safeParse(call.args);
  if (!parsed.success) {
    return call.finish({
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join(" "),
    });
  }
  const { deps, bot, run } = ctx;
  if (run.userId !== bot.userId) return call.finish({ error: "Only the bot's owner can do that." });
  // Only mail it received.
  const { count } = await deps.prisma.botEmailMessage.deleteMany({
    where: { id: { in: [...new Set(parsed.data.ids)] }, botId: bot.id, sent: false },
  });
  return call.finish({ deleted: count });
}

/** The bot's own inbox: mail anyone sent to its address. */
export const emailTools: ToolHandlers = { read_email: readEmail, delete_email: deleteEmail };
