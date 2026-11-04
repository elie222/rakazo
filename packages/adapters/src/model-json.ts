import { jsonrepair } from "jsonrepair";
import type { z } from "zod";

/** Models wrap JSON in prose or fences and break its syntax; repair it before checking the shape. */
export function parseModelJson<T extends z.ZodType>(
  text: string,
  schema: T,
): z.infer<T> | undefined {
  const candidate = text.match(/\{[\s\S]*\}/)?.[0] ?? text.trim();
  try {
    const result = schema.safeParse(JSON.parse(jsonrepair(candidate)));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
