export const BLOG_AUTHOR = "Elie Steinbock";

export function formatPostDate(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(value);
}

export function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** What a post's head says about it: og:type article, its dates and author. */
export type ArticleMeta = { published: Date; modified: Date; author: string };
