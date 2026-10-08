import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BLOG_CATEGORIES = ["comparisons", "guides", "roundups", "product"] as const;

export type BlogCategory = (typeof BLOG_CATEGORIES)[number];

/** A category page stays out of the index until it has this many posts. */
export const CATEGORY_INDEX_MIN = 3;

export const CATEGORY_LABEL: Record<BlogCategory, string> = {
  comparisons: "Comparisons",
  guides: "Guides",
  roundups: "Roundups",
  product: "Product",
};

const blogDir = join(dirname(fileURLToPath(import.meta.url)), "../content/blog");

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const CATEGORY_LINE = /^category:\s*["']?([a-z]+)["']?(?:\s+#.*)?\s*$/m;

/** Reads `category` from the YAML frontmatter block, including quoted values. */
export function categoryFromFrontmatter(text: string): BlogCategory | undefined {
  const block = FRONTMATTER.exec(text)?.[1];
  if (!block) return undefined;
  const category = CATEGORY_LINE.exec(block)?.[1];
  if (category && (BLOG_CATEGORIES as readonly string[]).includes(category)) {
    return category as BlogCategory;
  }
  return undefined;
}

export function categoryIsIndexedAtCount(count: number): boolean {
  return count >= CATEGORY_INDEX_MIN;
}

export function categoryCounts(): Map<BlogCategory, number> {
  const counts = new Map<BlogCategory, number>(BLOG_CATEGORIES.map((category) => [category, 0]));
  let files: string[] = [];
  try {
    files = readdirSync(blogDir);
  } catch {
    return counts;
  }
  for (const file of files) {
    if (!file.endsWith(".md") && !file.endsWith(".mdx")) continue;
    const category = categoryFromFrontmatter(readFileSync(join(blogDir, file), "utf8"));
    if (category && counts.has(category)) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return counts;
}

export function categoryIsIndexed(category: BlogCategory): boolean {
  return categoryIsIndexedAtCount(categoryCounts().get(category) ?? 0);
}

export function categoryPath(category: BlogCategory): string {
  return `/blog/${category}/`;
}

function normalizePath(pathname: string): string {
  if (pathname === "/") return "/";
  return pathname.replace(/\/+$/, "");
}

export function noindexPathnames(): string[] {
  return BLOG_CATEGORIES.filter((category) => !categoryIsIndexed(category)).map((category) =>
    categoryPath(category),
  );
}

/** True when a built URL should appear in the sitemap. */
export function isIndexedPath(pathname: string): boolean {
  const normalized = normalizePath(pathname);
  if (normalized.endsWith(".xml")) return false;
  return !noindexPathnames().some((path) => normalizePath(path) === normalized);
}
