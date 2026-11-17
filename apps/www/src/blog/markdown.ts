import type { CollectionEntry } from "astro:content";
import { absolute, cell } from "../provider-article/markdown";
import { SITE_URL } from "../site";
import { CATEGORY_LABEL, categoryPath } from "./categories";
import { formatPostDate } from "./format";

type Post = CollectionEntry<"blog">;

export const BLOG_DESCRIPTION =
  "Notes on running an open source AI agent yourself, including setup and how Rakazo compares with other projects.";

function siteUrl(href: string): string {
  return href.startsWith("/") ? `${SITE_URL}${href}` : href;
}

export function blogPostPath(slug: string): string {
  return `/blog/${slug}/`;
}

export function blogPostMarkdownPath(slug: string): string {
  return `/blog/${slug}.md`;
}

export function sortPosts(posts: readonly Post[]): Post[] {
  return [...posts].sort((a, b) => b.data.updated.getTime() - a.data.updated.getTime());
}

/** Markdown twin of a blog post, for agents and `.md` requests. */
export function blogPostMarkdown(post: Post): string {
  const { data } = post;
  const row = (cells: readonly string[]) =>
    `| ${cells.map((value) => cell(absolute(value))).join(" | ")} |`;
  return [
    `# ${data.title}`,
    "",
    `Published ${formatPostDate(data.published)}. Updated ${formatPostDate(data.updated)}. By ${data.author}. Filed under [${CATEGORY_LABEL[data.category]}](${SITE_URL}${categoryPath(data.category)}).`,
    "",
    "## TL;DR",
    "",
    absolute(data.tldr),
    "",
    "## Comparison",
    "",
    `**${data.comparison.caption}**`,
    "",
    row(data.comparison.columns),
    `| ${data.comparison.columns.map(() => "---").join(" | ")} |`,
    ...data.comparison.rows.map((item) => row([item.topic, ...item.cells])),
    "",
    absolute(post.body?.trim() ?? "").replace(/(src|href)="\//g, `$1="${SITE_URL}/`),
    "",
    "## FAQ",
    "",
    ...data.faq.flatMap((item) => [`### ${item.question}`, "", absolute(item.answer), ""]),
    "## Sources",
    "",
    ...data.sources.map((source) => `- [${source.label}](${source.href})`),
    "",
    "## Related",
    "",
    ...data.related.map((link) => `- [${link.title}](${siteUrl(link.href)}): ${link.description}`),
    "",
  ].join("\n");
}

export function blogIndexMarkdown(posts: readonly Post[]): string {
  return [
    "# Rakazo blog",
    "",
    BLOG_DESCRIPTION,
    "",
    ...sortPosts(posts).map(
      (post) =>
        `- [${post.data.title}](${SITE_URL}${blogPostPath(post.id)}) ([Markdown](${SITE_URL}${blogPostMarkdownPath(post.id)})): ${post.data.description} Updated ${formatPostDate(post.data.updated)}.`,
    ),
    "",
  ].join("\n");
}
