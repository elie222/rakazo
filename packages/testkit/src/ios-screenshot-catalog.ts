import { readFile } from "node:fs/promises";
import path from "node:path";

export interface IosScreenshotSection {
  id: string;
  title: string;
  flow: string;
}

const SECTION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function loadIosScreenshotCatalog(
  catalogDir: string,
): Promise<IosScreenshotSection[]> {
  const catalogPath = path.join(catalogDir, "catalog.json");
  const parsed: unknown = JSON.parse(await readFile(catalogPath, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("iOS screenshot catalog must be a non-empty array");
  }
  const seen = new Set<string>();
  const sections: IosScreenshotSection[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      throw new Error("iOS screenshot catalog entries must be objects");
    }
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const title = record.title;
    const flow = record.flow;
    if (typeof id !== "string" || !SECTION_ID.test(id)) {
      throw new Error(`Invalid iOS screenshot section id: ${String(id)}`);
    }
    if (seen.has(id)) throw new Error(`Duplicate iOS screenshot section: ${id}`);
    seen.add(id);
    if (typeof title !== "string" || !title.trim()) {
      throw new Error(`Section ${id} needs a title`);
    }
    if (typeof flow !== "string" || flow.split(/[\\/]/).includes("..") || path.isAbsolute(flow)) {
      throw new Error(`Section ${id} has an unsafe flow path`);
    }
    sections.push({ id, title: title.trim(), flow });
  }
  return sections;
}
