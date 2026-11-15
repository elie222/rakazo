import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BlogCategory } from "./categories";
import { BLOG_CATEGORIES, categoryPath } from "./categories";

/** A category page stays out of the index until it has this many posts. */
export const CATEGORY_INDEX_MIN = 3;

const blogDir = join(dirname(fileURLToPath(import.meta.url)), "../content/blog");

export const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const CATEGORY_LINE = /^category:\s*["']?([a-z]+)["']?(?:\s+#.*)?\s*$/m;
const UPDATED_LINE = /^updated:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m;

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

/** Reads `updated` from the YAML frontmatter block as an ISO date. */
export function updatedFromFrontmatter(text: string): string | undefined {
  const block = FRONTMATTER.exec(text)?.[1];
  return block ? UPDATED_LINE.exec(block)?.[1] : undefined;
}

function blogPosts(): { slug: string; text: string }[] {
  let files: string[] = [];
  try {
    files = readdirSync(blogDir);
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith(".md") || file.endsWith(".mdx"))
    .map((file) => ({
      slug: file.replace(/\.mdx?$/, ""),
      text: readFileSync(join(blogDir, file), "utf8"),
    }));
}

/** Each post's `updated` date by slug. */
export function blogUpdatedDates(): Map<string, string> {
  const dates = new Map<string, string>();
  for (const post of blogPosts()) {
    const updated = updatedFromFrontmatter(post.text);
    if (updated) dates.set(post.slug, updated);
  }
  return dates;
}

export function categoryIsIndexedAtCount(count: number): boolean {
  return count >= CATEGORY_INDEX_MIN;
}

export function categoryCounts(): Map<BlogCategory, number> {
  const counts = new Map<BlogCategory, number>(BLOG_CATEGORIES.map((category) => [category, 0]));
  for (const post of blogPosts()) {
    const category = categoryFromFrontmatter(post.text);
    if (category && counts.has(category)) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return counts;
}

export function categoryIsIndexed(category: BlogCategory): boolean {
  return categoryIsIndexedAtCount(categoryCounts().get(category) ?? 0);
}

function normalizePath(pathname: string): string {
  if (pathname === "/") return "/";
  return pathname.replace(/\/+$/, "");
}

/** True when a built URL should appear in the sitemap. */
export function isIndexedPath(pathname: string): boolean {
  const normalized = normalizePath(pathname);
  if (normalized.endsWith(".xml")) return false;
  // Claim forms are for an app's owner, not for search.
  if (/^\/integrations\/[^/]+\/claim$/.test(normalized)) return false;
  const category = BLOG_CATEGORIES.find(
    (candidate) => normalizePath(categoryPath(candidate)) === normalized,
  );
  return category === undefined || categoryIsIndexed(category);
}
