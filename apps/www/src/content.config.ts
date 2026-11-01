import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { readFile } from "node:fs/promises";
import { DOCS_SLUGS } from "./docs";
import { rewriteDocsLinks } from "./docs-links";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    published: z.coerce.date(),
    updated: z.coerce.date(),
    author: z.literal("Elie Steinbock"),
    category: z.enum(["comparisons", "guides", "roundups", "product"]),
    tldr: z.string(),
    sources: z.array(z.object({ label: z.string(), href: z.string().url() })).min(1),
    related: z
      .array(
        z.object({
          href: z.string(),
          title: z.string(),
          description: z.string(),
        }),
      )
      .min(3)
      .max(5),
    faq: z.array(z.object({ question: z.string(), answer: z.string() })).min(1),
    comparison: z.object({
      caption: z.string(),
      columns: z.array(z.string()).min(2),
      rows: z.array(
        z.object({
          topic: z.string(),
          cells: z.array(z.string()).min(1),
        }),
      ),
    }),
  }),
});

/** The paragraph right under a doc's H1, as plain text, for its meta description. */
function leadParagraph(markdown: string): string | undefined {
  const blocks = markdown.split(/\n\s*\n/).map((block) => block.trim());
  const heading = blocks.findIndex((block) => block.startsWith("# "));
  const lead = heading < 0 ? undefined : blocks[heading + 1];
  if (!lead || /^[#>!<|`*\-\d]/.test(lead)) return undefined;
  return lead
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ");
}

const docs = defineCollection({
  schema: z.object({ description: z.string().optional() }),
  loader: {
    name: "repo-docs",
    async load({ store, renderMarkdown, watcher }) {
      store.clear();
      for (const slug of DOCS_SLUGS) {
        const url = new URL(`../../../docs/${slug}.md`, import.meta.url);
        const body = rewriteDocsLinks(await readFile(url, "utf8"), slug);
        store.set({
          id: slug,
          data: { description: leadParagraph(body) },
          body,
          rendered: await renderMarkdown(body),
        });
        watcher?.add(url.pathname);
      }
    },
  },
});

export const collections = { blog, docs };
