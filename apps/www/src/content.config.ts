import { defineCollection } from "astro:content";
import { readFile } from "node:fs/promises";
import { z } from "astro/zod";
import type { collections as marketingCollections } from "marketing-content";
import { DOCS_SLUGS } from "./docs";
import { rewriteDocsLinks } from "./docs-links";

const marketing = import.meta.glob<{ collections: typeof marketingCollections }>(
  "./marketing/content.ts",
  { eager: true },
);

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

export const collections = { docs, ...marketing["./marketing/content.ts"]?.collections };
