import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

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

export const collections = { blog };
