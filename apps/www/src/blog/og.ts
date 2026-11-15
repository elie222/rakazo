import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OgPage } from "../og-pages";
import { type BlogCategory, categoryFromFrontmatter } from "./indexability";

const blogDir = join(dirname(fileURLToPath(import.meta.url)), "../content/blog");

const KICKER: Record<BlogCategory, string> = {
  comparisons: "Comparison",
  guides: "Guide",
  roundups: "Roundup",
  product: "Product",
};

function frontmatterString(text: string, key: string): string | undefined {
  const value = new RegExp(`^${key}:\\s*(".*")\\s*$`, "m").exec(text)?.[1];
  return value === undefined ? undefined : (JSON.parse(value) as string);
}

export function blogOgId(slug: string): string {
  return `blog-${slug}`;
}

/** The Open Graph card for a post, from its frontmatter: `ogTitle` when the title is too long for the card. */
export function blogOgPage(slug: string, markdown: string): OgPage {
  const category = categoryFromFrontmatter(markdown);
  const title = frontmatterString(markdown, "ogTitle") ?? frontmatterString(markdown, "title");
  if (!category || !title) throw new Error(`Blog post ${slug} needs a title and a category`);
  return { id: blogOgId(slug), kicker: KICKER[category], title };
}

export function blogOgPages(): OgPage[] {
  return readdirSync(blogDir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) =>
      blogOgPage(file.replace(/\.md$/, ""), readFileSync(join(blogDir, file), "utf8")),
    );
}
