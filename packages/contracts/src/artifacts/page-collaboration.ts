import * as z from "zod";
import { Id, IsoDate } from "../ids.js";
import { PageStateSchema } from "./page-reader-state.js";
import { PageImagesSchema } from "./pages.js";

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
  images: PageImagesSchema,
  currentVersion: PageVersionNumber,
  version: PageVersionNumber,
  owner: z.boolean(),
  canRequestRevision: z.boolean(),
  readerState: PageStateSchema.optional(),
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
/** The reviewer may still read the page; only the revision they asked for is not theirs to read. */
export const PAGE_REVISION_NOT_FOUND = "PAGE_REVISION_NOT_FOUND";

/**
 * The lowest revision the server confirmed the reader may read, which that refusal sends as its
 * `data.readableFrom`. Undefined for any other answer, or when the detail is missing or invalid.
 */
export function pageRevisionFloor(error: unknown): number | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code !== PAGE_REVISION_NOT_FOUND) return undefined;
  const data = error && typeof error === "object" && "data" in error ? error.data : undefined;
  const floor =
    data && typeof data === "object" && "readableFrom" in data ? data.readableFrom : undefined;
  const parsed = PageVersionNumber.safeParse(floor);
  return parsed.success ? parsed.data : undefined;
}
