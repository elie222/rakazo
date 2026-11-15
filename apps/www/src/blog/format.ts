export const BLOG_AUTHOR = "Elie Steinbock";

export const BLOG_AUTHOR_PERSON = {
  "@type": "Person",
  name: BLOG_AUTHOR,
  url: "https://github.com/elie222",
  sameAs: ["https://x.com/elie2222", "https://github.com/elie222"],
};

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
