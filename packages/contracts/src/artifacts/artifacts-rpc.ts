import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import { botId } from "../rpc/inputs.js";
import {
  ARTIFACT_DESCRIPTION_MAX_LENGTH,
  ARTIFACT_NAME_MAX_LENGTH,
} from "../threads/attachments.js";
import { threadTarget } from "../threads/thread-send.js";
import { ArtifactSchema, ArtifactVersionSchema, ArtifactWithContentSchema } from "./artifacts.js";
import {
  BoardEventSchema,
  BoardSchema,
  CommentTicketInput,
  CreateTicketInput,
  GetTicketInput,
  ListTicketsInput,
  ListTicketsOutput,
  MoveTicketInput,
  RenameBoardInput,
  TicketCommentSchema,
  TicketSchema,
  UpdateTicketInput,
} from "./board.js";
import {
  PAGE_LIST_MAX_LIMIT,
  PageDetailSchema,
  PageSummarySchema,
  PageTitleSchema,
  PageVisibilitySchema,
} from "./pages.js";

export const artifactsRpc = {
  boards: {
    list: oc.output(z.array(BoardSchema)),
    get: oc.output(BoardSchema),
    rename: oc.input(RenameBoardInput).output(BoardSchema),
    subscribe: oc.output(eventIterator(BoardEventSchema)),
  },
  tickets: {
    list: oc.input(ListTicketsInput).output(ListTicketsOutput),
    get: oc.input(GetTicketInput).output(TicketSchema),
    create: oc.input(CreateTicketInput).output(TicketSchema),
    update: oc.input(UpdateTicketInput).output(TicketSchema),
    move: oc.input(MoveTicketInput).output(TicketSchema),
    comment: oc.input(CommentTicketInput).output(TicketCommentSchema),
    comments: oc.input(z.object({ ticketId: Id })).output(z.array(TicketCommentSchema)),
  },
  artifacts: {
    list: oc.input(botId).output(z.array(ArtifactSchema)),
    listSpace: oc
      .input(
        z.object({
          botId: Id.optional(),
          /** Only files bots attached, leaving out uploads. */
          madeByBots: z.boolean().optional(),
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(60).optional(),
        }),
      )
      .output(
        z.object({
          items: z.array(ArtifactSchema.extend({ versionCount: z.number().int() })),
          nextCursor: z.string().nullable(),
        }),
      ),
    listVersions: oc.input(z.object({ familyId: Id })).output(z.array(ArtifactVersionSchema)),
    create: oc
      .input(
        threadTarget.and(
          z.object({
            name: z.string().min(1).max(ARTIFACT_NAME_MAX_LENGTH),
            description: z.string().max(ARTIFACT_DESCRIPTION_MAX_LENGTH).optional(),
            mimeType: z.string().min(1),
            contentBase64: z.string().min(1),
            /** Unique per upload; a retry with the same nonce returns the artifact it created. */
            clientNonce: z.string().min(1).max(200).optional(),
          }),
        ),
      )
      .output(ArtifactSchema),
    get: oc.input(threadTarget.and(z.object({ artifactId: Id }))).output(ArtifactWithContentSchema),
    getById: oc.input(z.object({ artifactId: Id })).output(ArtifactWithContentSchema),
    remove: oc.input(z.object({ artifactId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  /** Pages bots built for the caller in this Space. */
  pages: {
    /** Pinned first, then most recently updated. */
    list: oc
      .input(
        z.strictObject({
          botId: Id.optional(),
          groupId: Id.optional(),
          cursor: z.string().max(500).optional(),
          limit: z.number().int().min(1).max(PAGE_LIST_MAX_LIMIT).optional(),
          /** Titles containing this text, for the command palette. */
          query: z.string().trim().min(1).max(200).optional(),
        }),
      )
      .output(
        z.strictObject({ items: z.array(PageSummarySchema), nextCursor: z.string().nullable() }),
      ),
    /** `link` also reads the page's share link, which only the share controls need. */
    get: oc
      .input(
        z.strictObject({
          pageId: Id,
          version: z.number().int().positive().optional(),
          link: z.boolean().optional(),
        }),
      )
      .output(PageDetailSchema),
    rename: oc
      .input(z.strictObject({ pageId: Id, title: PageTitleSchema }))
      .output(PageSummarySchema),
    /**
     * Turning the link on returns the page's live link, or a new one when it has none it can
     * read; turning it off breaks the old link, so the next turn-on issues a new one.
     */
    setVisibility: oc
      .input(z.strictObject({ pageId: Id, visibility: PageVisibilitySchema }))
      .output(
        z.strictObject({ visibility: PageVisibilitySchema, shareUrl: z.string().nullable() }),
      ),
    pin: oc.input(z.strictObject({ pageId: Id, pinned: z.boolean() })).output(PageSummarySchema),
    remove: oc.input(z.strictObject({ pageId: Id })).output(z.object({ ok: z.literal(true) })),
  },
};
