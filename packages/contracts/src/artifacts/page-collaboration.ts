import * as z from "zod";
import { Id, IsoDate } from "../ids.js";

export const PageVersionNumber = z.number().int().positive();
export const PageSection = z.string().trim().min(1).max(200);
export const PageSectionOccurrence = z.number().int().min(0).max(79);
export type PageSectionAnchor = { section: string; sectionOccurrence?: number };
export const PageCommentBody = z.string().trim().min(1).max(4000);
export const PageAccessInput = z.strictObject({ pageId: Id });

export const PageReviewSchema = z.strictObject({
  id: Id,
  title: z.string(),
  code: z.string(),
  currentVersion: PageVersionNumber,
  version: PageVersionNumber,
  owner: z.boolean(),
  canRequestRevision: z.boolean(),
});

export const PageGrantSchema = z.strictObject({ id: Id, email: z.string() });
export const PageRevisionStatus = z.enum(["pending", "ready", "published", "failed", "cancelled"]);

export const PageCommentSchema = z.strictObject({
  id: Id,
  version: PageVersionNumber,
  section: PageSection,
  sectionOccurrence: PageSectionOccurrence.optional(),
  body: PageCommentBody,
  author: z.string().nullable(),
  mine: z.boolean(),
  createdAt: IsoDate,
  resolvedAt: IsoDate.nullable(),
  revision: z
    .strictObject({
      id: Id,
      status: PageRevisionStatus,
      resultVersion: PageVersionNumber.nullable(),
    })
    .nullable(),
});

export type PageComment = z.infer<typeof PageCommentSchema>;
export type PageReview = z.infer<typeof PageReviewSchema>;
export const pageReviewPath = (id: string) => `/review/${encodeURIComponent(id)}`;
