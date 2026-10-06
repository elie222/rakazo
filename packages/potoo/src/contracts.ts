import { z } from "zod";

export const ConfidenceSchema = z.enum(["confirmed", "likely", "unclear"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const SeveritySchema = z.enum(["high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(2000),
  evidence: z.array(z.string().min(1)).default([]),
  confidence: ConfidenceSchema,
  severity: SeveritySchema,
});
export type Finding = z.infer<typeof FindingSchema>;

export const ReportSchema = z.object({
  findings: z.array(FindingSchema),
  back_page: z.array(z.string().min(1)).default([]),
  record: z.string().min(1),
});
export type Report = z.infer<typeof ReportSchema>;

const FENCED_JSON_RE = /```json\s*([\s\S]*?)```/;

export function extractJsonBlock(text: string): string | null {
  const match = FENCED_JSON_RE.exec(text);
  if (!match?.[1]) return null;
  return match[1].trim();
}

export function parseReport(text: string): Report | null {
  const block = extractJsonBlock(text);
  if (!block) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return null;
  }
  const result = ReportSchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data;
}
