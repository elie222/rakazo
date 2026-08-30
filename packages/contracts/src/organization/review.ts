import * as z from "zod";
import { Id } from "../ids.js";

export const ReviewStatusSchema = z.enum(["pending", "approved", "changes_requested", "cancelled"]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const ReviewDecisionSchema = z.object({
  decision: z.enum(["approve", "changes_requested"]),
  summary: z.string().min(1).max(4000),
  feedback: z.string().max(8000).nullable(),
  evidence: z
    .array(
      z.object({
        type: z.enum(["artifact", "run_output", "test_result", "note"]),
        reference: z.string().min(1).max(1000),
        description: z.string().min(1).max(2000),
      }),
    )
    .max(20),
});
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const WorkItemReviewSchema = z.object({
  id: Id,
  workspaceId: Id,
  workItemId: Id,
  reviewerBotId: Id.nullable(),
  status: ReviewStatusSchema,
  summary: z.string().max(4000),
  feedback: z.string().max(8000),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type WorkItemReview = z.infer<typeof WorkItemReviewSchema>;

export const CreateReviewInput = z.object({
  workItemId: Id,
  reviewerBotId: Id.nullable().optional(),
  summary: z.string().max(4000).default(""),
});
export type CreateReviewInput = z.infer<typeof CreateReviewInput>;

export const CompleteReviewInput = z.object({
  reviewId: Id,
  status: z.enum(["approved", "changes_requested", "cancelled"]),
  summary: z.string().max(4000).optional(),
  feedback: z.string().max(8000).optional(),
});
export type CompleteReviewInput = z.infer<typeof CompleteReviewInput>;
