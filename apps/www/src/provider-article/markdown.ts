import { SITE_URL } from "../site";
import type { ArticleHub, ArticleLink, ArticleSection, ArticleTable, ProviderArticle } from "./types";

/** Absolute links for agent Markdown, which is read outside the site. */
export function absolute(text: string): string {
  return text.replace(/\]\((\/[^)]*)\)/g, `](${SITE_URL}$1)`);
}

export function cell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function tableMarkdown(table: ArticleTable): string[] {
  const row = (cells: readonly string[]) => `| ${cells.map((value) => cell(absolute(value))).join(" | ")} |`;
  return [
    `**${table.caption}**`,
    "",
    row(table.columns),
    `| ${table.columns.map(() => "---").join(" | ")} |`,
    ...table.rows.map((item) => row([item.topic, ...item.cells])),
    "",
    ...(table.note ? [absolute(table.note), ""] : []),
  ];
}

export function sectionMarkdown(section: ArticleSection): string[] {
  return [
    `## ${section.heading}`,
    "",
    ...(section.paragraphs ?? []).flatMap((paragraph) => [absolute(paragraph), ""]),
    ...(section.table ? tableMarkdown(section.table) : []),
    ...(section.bullets?.length ? [...section.bullets.map((item) => `- ${absolute(item)}`), ""] : []),
    ...(section.steps?.length
      ? [...section.steps.map((step, index) => `${index + 1}. ${absolute(step)}`), ""]
      : []),
  ];
}

/** Markdown twin of a provider article, for agents and `.md` requests. */
export function articleMarkdown(
  article: ProviderArticle,
  options: { hub: ArticleHub; others: readonly ArticleLink[]; updated: string },
): string {
  return [
    `# ${article.h1}`,
    "",
    ...article.intro.flatMap((paragraph) => [absolute(paragraph), ""]),
    `Updated ${options.updated}.`,
    "",
    ...article.sections.flatMap(sectionMarkdown),
    "## FAQ",
    "",
    ...article.faq.flatMap((item) => [`### ${item.question}`, "", absolute(item.answer), ""]),
    `## ${options.hub.moreHeading}`,
    "",
    `- [${options.hub.compareLabel}](${SITE_URL}${options.hub.href})`,
    ...options.others.map((other) => `- [${other.name}](${SITE_URL}${other.href}): ${other.meta}`),
    "",
    "## Sources",
    "",
    ...article.sources.map((source) => `- [${source.label}](${source.href})`),
    "",
  ].join("\n");
}
