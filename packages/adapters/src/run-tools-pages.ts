import type { MessageBlock } from "@rakazo/contracts";
import { PAGE_TITLE_MAX_LENGTH, PageTitleSchema } from "@rakazo/contracts";
import { containsSecret, redactSecrets } from "@rakazo/core";
import { checkPageSource, PAGE_KIT_GUIDE } from "@rakazo/page-kit/validate";
import type { RunContext } from "./run-context.js";
import { isUniqueViolation, publishMessage } from "./run-messages.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { argumentGiven } from "./update-bot-patch.js";

const MAX_EDITS = 50;

type PageEdit = { find: string; replace: string };

/** All edits or none: each `find` must occur exactly once in the result of the edits before it. */
function applyPageEdits(
  source: string,
  edits: readonly PageEdit[],
): { ok: true; source: string } | { ok: false; error: string } {
  let next = source;
  for (const [index, edit] of edits.entries()) {
    const label = `Edit ${index + 1}`;
    if (!edit.find) return { ok: false, error: `${label}: find is empty.` };
    const at = next.indexOf(edit.find);
    if (at === -1) return { ok: false, error: `${label}: find text was not found in the page.` };
    if (next.indexOf(edit.find, at + 1) !== -1) {
      return {
        ok: false,
        error: `${label}: find text occurs more than once; include more surrounding text.`,
      };
    }
    next = next.slice(0, at) + edit.replace + next.slice(at + edit.find.length);
  }
  return { ok: true, source: next };
}

function parseEdits(value: unknown): PageEdit[] | string {
  if (!Array.isArray(value) || value.length === 0) return "edits must be a non-empty list.";
  if (value.length > MAX_EDITS) return `Send at most ${MAX_EDITS} edits at once.`;
  const edits: PageEdit[] = [];
  for (const [index, item] of value.entries()) {
    const edit = item as Partial<PageEdit> | null;
    if (typeof edit?.find !== "string" || typeof edit.replace !== "string") {
      return `Edit ${index + 1}: needs find and replace strings.`;
    }
    edits.push({ find: edit.find, replace: edit.replace });
  }
  return edits;
}

async function savePage(ctx: RunContext, call: ToolCall) {
  const { deps, run, bot, thread } = ctx;
  const { args } = call;
  if (args.help === true) return { guide: PAGE_KIT_GUIDE };
  const pageId = argumentGiven(args.pageId) ? String(args.pageId) : undefined;
  const hasSource = argumentGiven(args.source);
  // Serializers send unused optional fields blank, an empty list included.
  const hasEdits = Array.isArray(args.edits) ? args.edits.length > 0 : argumentGiven(args.edits);
  if (hasSource && hasEdits) return { error: "Send either source or edits, not both." };
  let title: string | undefined;
  if (argumentGiven(args.title)) {
    const parsed = PageTitleSchema.safeParse(args.title);
    if (!parsed.success) return { error: "title must be 1 to 200 characters." };
    title = redactSecrets(parsed.data, ctx.secrets).slice(0, PAGE_TITLE_MAX_LENGTH);
  }

  // A bot reaches its own pages and its group's pages, from any of its chats or routines; another
  // bot's page answers as if it did not exist, since its source may hold that chat's text.
  const reachable = thread.groupId
    ? [{ botId: bot.id }, { groupId: thread.groupId }]
    : [{ botId: bot.id }];
  const page = pageId
    ? await deps.prisma.page.findFirst({
        where: { id: pageId, spaceId: run.spaceId, userId: run.userId, OR: reachable },
        select: {
          id: true,
          title: true,
          currentVersion: true,
          versions: { orderBy: { version: "desc" }, take: 1, select: { source: true } },
        },
      })
    : null;
  if (pageId && !page) return { error: "No page with that pageId belongs to this bot or chat." };
  const current = page?.versions[0]?.source ?? "";

  if (page && !hasSource && !hasEdits && !title) {
    // The stored source may hold outside text an earlier run put in the page, so reading it
    // taints this run like any other outside content; saves only confirm this run's own write.
    ctx.state.tainted = true;
    return { pageId: page.id, version: page.currentVersion, title: page.title, source: current };
  }
  if (!page && hasEdits) return { error: "edits need the pageId of the page to change." };
  if (!page && !hasSource) return { error: "A new page needs source." };
  if (!page && !title) return { error: "A new page needs a title." };

  let source = hasSource ? String(args.source) : current;
  if (hasEdits) {
    const edits = parseEdits(args.edits);
    if (typeof edits === "string") return { error: edits, unchanged: true };
    const applied = applyPageEdits(current, edits);
    if (!applied.ok) return { error: applied.error, unchanged: true };
    source = applied.source;
  }
  const check = checkPageSource(source);
  if (!check.ok) {
    return { error: "The page has problems; nothing was saved.", problems: check.errors };
  }
  // A page can be shared by link, so it never stores a value this run keeps secret.
  if (containsSecret([source, check.code], ctx.secrets)) {
    return {
      error: "The page contains a secret value; nothing was saved. Remove it and save again.",
      unchanged: true,
    };
  }

  let saved: { pageId: string; version: number; title: string };
  try {
    saved = await deps.prisma.$transaction(async (tx) => {
      if (!page) {
        const created = await tx.page.create({
          data: {
            spaceId: run.spaceId,
            userId: run.userId,
            botId: bot.id,
            groupId: thread.groupId,
            title: title!,
            versions: { create: { version: 1, title: title!, source, code: check.code } },
          },
        });
        return { pageId: created.id, version: 1, title: created.title };
      }
      const version = page.currentVersion + 1;
      // Conditional on the version this change was built from, so two saves never interleave.
      // With no new title the page keeps its current one, even a rename made after the read.
      const moved = await tx.page.updateMany({
        where: { id: page.id, currentVersion: page.currentVersion },
        data: { currentVersion: version, title, updatedAt: new Date() },
      });
      if (moved.count === 0) throw new PageChangedError();
      let nextTitle =
        title ??
        (await tx.page.findUniqueOrThrow({ where: { id: page.id }, select: { title: true } }))
          .title;
      // A title saved before this run learned a secret is redacted before it is shown again.
      const kept = redactSecrets(nextTitle, ctx.secrets).slice(0, PAGE_TITLE_MAX_LENGTH);
      if (kept !== nextTitle) {
        nextTitle = kept;
        await tx.page.update({ where: { id: page.id }, data: { title: kept } });
      }
      await tx.pageVersion.create({
        data: { pageId: page.id, version, title: nextTitle, source, code: check.code },
      });
      return { pageId: page.id, version, title: nextTitle };
    });
  } catch (error) {
    if (error instanceof PageChangedError || isUniqueViolation(error)) {
      return { error: "The page changed while saving; read it again and retry.", unchanged: true };
    }
    throw error;
  }
  const block: MessageBlock = { kind: "page", ...saved };
  const linkText = saved.title.replace(/[\\[\]]/g, "\\$&");
  try {
    // A routine speaks only through its final reply, which may be silence, so refreshing a
    // page it already showed posts no card; its first save still does.
    if (!page || run.trigger !== "routine") await publishMessage(deps, run, "bot", [block]);
  } catch (error) {
    // The page is saved; only its card in the chat is missing, so the bot can still link it.
    return {
      ...saved,
      error: `The page was saved, but its card could not be posted in the chat (${
        error instanceof Error ? error.message : "unknown error"
      }). Link it in your reply as [${linkText}](page:${saved.pageId}).`,
    };
  }
  const result = {
    ...saved,
    mention: `Mention it in your reply as [${linkText}](page:${saved.pageId})`,
  };
  return check.warnings?.length ? { ...result, warnings: check.warnings } : result;
}

class PageChangedError extends Error {}

export const pageTools: ToolHandlers = {
  async save_page(ctx, call) {
    return call.finish(await savePage(ctx, call));
  },
};
