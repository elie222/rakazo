import * as z from "zod";
import { pageShareTokenFromSlug } from "../artifacts/pages.js";
import { Id, IsoDate } from "../ids.js";

/** What anyone with a reply's link reads: its plain text, the bot's name and when it was shared. */
export const SharedReplySchema = z.strictObject({
  botName: z.string(),
  text: z.string(),
  sharedAt: IsoDate,
});
export type SharedReply = z.infer<typeof SharedReplySchema>;

/** One link in the sharer's list; `preview` is the reply's first words. */
export const ReplyShareSummarySchema = z.strictObject({
  id: Id,
  botName: z.string(),
  preview: z.string(),
  createdAt: IsoDate,
});
export type ReplyShareSummary = z.infer<typeof ReplyShareSummarySchema>;

export const SHARED_REPLY_PATH_PREFIX = "/api/v1/replies/shared/";

/** `<web origin>/c/<token>`. */
export function replyShareUrl(webOrigin: string, token: string): string {
  return new URL(`/c/${token}`, webOrigin).href;
}

/** Whether a path segment is a share token alone, of the same shape as a page's, before anything looks it up. */
export function isReplyShareToken(segment: string): boolean {
  return pageShareTokenFromSlug(segment) === segment;
}
