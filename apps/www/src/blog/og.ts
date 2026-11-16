import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OgPage } from "../og-pages";
import type { BlogCategory } from "./categories";
import { categoryFromFrontmatter, FRONTMATTER } from "./indexability";

const blogDir = join(dirname(fileURLToPath(import.meta.url)), "../content/blog");

const KICKER: Record<BlogCategory, string> = {
  comparisons: "Comparison",
  guides: "Guide",
  roundups: "Roundup",
  product: "Product",
};

/** A one-line YAML string from the frontmatter block: double-quoted, single-quoted or plain. */
function frontmatterString(markdown: string, key: string): string | undefined {
  const block = FRONTMATTER.exec(markdown)?.[1] ?? "";
  const value = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m").exec(block)?.[1];
  if (!value) return undefined;
  const doubleQuoted = /^("(?:[^"\\]|\\.)*")/.exec(value)?.[1];
  if (doubleQuoted) return JSON.parse(doubleQuoted) as string;
  const singleQuoted = /^'((?:[^']|'')*)'/.exec(value)?.[1];
  if (singleQuoted !== undefined) return singleQuoted.replaceAll("''", "'");
  return value.replace(/\s+#.*$/, "");
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
