export const BLOG_CATEGORIES = ["comparisons", "guides", "roundups", "product"] as const;

export type BlogCategory = (typeof BLOG_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<BlogCategory, string> = {
  comparisons: "Comparisons",
  guides: "Guides",
  roundups: "Roundups",
  product: "Product",
};

export function categoryPath(category: BlogCategory): string {
  return `/blog/${category}/`;
}
