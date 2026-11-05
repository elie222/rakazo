import { setTimeout as sleep } from "node:timers/promises";
import { BOT_EMAIL_NAME_TAKEN, BotEmailNameSchema } from "@rakazo/contracts";
import { attachmentComputerPath, redactSecrets } from "@rakazo/core";
import { claimBotEmailName } from "@rakazo/db";
import { z } from "zod";
import { redactConnectorPayload } from "./connector-safety.js";
import type { RunContext } from "./run-context.js";
import { isRunTainted, refuseOwnerSettingsChange } from "./run-context.js";
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
    before: z.iso.datetime({ offset: true }).optional(),
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

/** A tool call's argument problems, on one line. */
function argsError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join(" ");
}

function sender(email: { fromName: string; fromAddress: string }): string {
  return email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress;
}

type SavedFile = { name: string; artifactId?: string; mimeType?: string; size?: number };

async function readEmail(ctx: RunContext, call: ToolCall) {
  const parsed = ReadEmailSchema.safeParse(call.args);
  if (!parsed.success) {
    return call.finish({ error: argsError(parsed.error) });
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
    // Masked whole before paging, so a secret split across two pages is still caught.
    const body = redactSecrets(email.text, ctx.secrets);
    const text = body.slice(offset, offset + TEXT_PAGE_CHARS);
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
    // A service can echo a password or code the bot holds as a secret.
    const shown = redactConnectorPayload(
      {
        id: email.id,
        from: sender(email),
        verified: email.verified,
        to: email.to,
        ...(email.cc.length ? { cc: email.cc } : {}),
        subject: email.subject,
        receivedAt: email.receivedAt.toISOString(),
        text,
        ...(offset + TEXT_PAGE_CHARS < body.length
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
      ctx.secrets,
    );
    return call.finish({ untrusted: true, email: shown });
  }

  const startedAt = Date.now();
  const where = {
    botId: bot.id,
    ...(input.since || input.before
      ? {
          receivedAt: {
            ...(input.since ? { gt: new Date(input.since) } : {}),
            ...(input.before ? { lt: new Date(input.before) } : {}),
          },
        }
      : {}),
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
      // After since, oldest first, so following nextSince reads every new email in order.
      orderBy: { receivedAt: input.since ? ("asc" as const) : ("desc" as const) },
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
  const deadline = startedAt + (input.waitSeconds ?? 0) * 1000;
  // The last look lands on the deadline, so a wait shorter than one poll still waits.
  for (
    let left = deadline - Date.now();
    emails.length === 0 && left > 0;
    left = deadline - Date.now()
  ) {
    await sleep(Math.min(POLL_MS, left), undefined, { signal: ctx.context.signal });
    emails = await list();
  }
  // Where the next look starts, on the inbox's own clock: the newest email shown here, or the
  // caller's since when nothing new arrived.
  const newest = input.since ? emails.at(-1) : emails[0];
  const nextSince = newest?.receivedAt.toISOString() ?? input.since;
  const listed = emails.map((email) => ({
    id: email.id,
    from: sender(email),
    verified: email.verified,
    subject: email.subject,
    receivedAt: email.receivedAt.toISOString(),
    preview: redactSecrets(email.text, ctx.secrets)
      .slice(0, PREVIEW_CHARS)
      .replace(/\s+/g, " ")
      .trim(),
    ...((email.attachments as SavedFile[]).length
      ? { files: (email.attachments as SavedFile[]).length }
      : {}),
  }));
  return call.finish({
    untrusted: true,
    ...(nextSince ? { nextSince } : {}),
    emails: redactConnectorPayload(listed, ctx.secrets),
  });
}

async function deleteEmail(ctx: RunContext, call: ToolCall) {
  const parsed = DeleteEmailSchema.safeParse(call.args);
  if (!parsed.success) {
    return call.finish({ error: argsError(parsed.error) });
  }
  const { deps, bot, run } = ctx;
  if (run.userId !== bot.userId) return call.finish({ error: "Only the bot's owner can do that." });
  // Only mail it received.
  const { count } = await deps.prisma.botEmailMessage.deleteMany({
    where: { id: { in: [...new Set(parsed.data.ids)] }, botId: bot.id, sent: false },
  });
  return call.finish({ deleted: count });
}

/** The owner gives the bot its permanent address from chat. */
async function claimEmailAddress(ctx: RunContext, call: ToolCall) {
  const { deps, bot, run } = ctx;
  const domain = deps.inboundEmailDomain;
  if (!domain) return call.finish({ error: "This server doesn't receive email." });
  if (run.userId !== bot.userId) return call.finish({ error: "Only the bot's owner can do that." });
  // Permanent: without the owner's own approval of this call, text the bot read cannot pick it.
  if (call.nextApprovedTool !== "claim_email_address" && (await isRunTainted(ctx))) {
    return call.finish(
      refuseOwnerSettingsChange(
        ctx,
        "An email address can't be claimed in this run because it read outside content. Ask your owner to request it again.",
      ),
    );
  }
  const parsed = BotEmailNameSchema.safeParse(call.args.name);
  if (!parsed.success) {
    return call.finish({ error: parsed.error.issues[0]?.message ?? "Choose another name." });
  }
  const result = await claimBotEmailName(deps.prisma, bot.id, parsed.data);
  if (result === "taken")
    return call.finish({ error: `${BOT_EMAIL_NAME_TAKEN}. Ask for another.` });
  if (result === "has-another") {
    const current = await deps.prisma.botEmailAddress.findUnique({
      where: { botId: bot.id },
      select: { localPart: true },
    });
    return call.finish({
      error: "You already have an address, and it can't change.",
      address: current ? `${current.localPart}@${domain}` : undefined,
    });
  }
  return call.finish({ address: `${parsed.data}@${domain}` });
}

/** The bot's own address and inbox: mail anyone sent to it. */
export const emailTools: ToolHandlers = {
  read_email: readEmail,
  delete_email: deleteEmail,
  claim_email_address: claimEmailAddress,
};
