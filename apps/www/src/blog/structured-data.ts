import { SITE_NAME, SITE_URL } from "../site";
import { BLOG_AUTHOR } from "./format";

export function blogPostStructuredData(input: {
  pageUrl: string;
  title: string;
  description: string;
  published: string;
  updated: string;
  image: string;
  categoryLabel: string;
  categoryUrl: string;
}) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BlogPosting",
        "@id": `${input.pageUrl}#article`,
        headline: input.title,
        description: input.description,
        datePublished: input.published,
        dateModified: input.updated,
        author: {
          "@type": "Person",
          name: BLOG_AUTHOR,
        },
        publisher: {
          "@type": "Organization",
          name: SITE_NAME,
          url: `${SITE_URL}/`,
          logo: {
            "@type": "ImageObject",
            url: `${SITE_URL}/brand/rakazo-mark.svg`,
          },
        },
        image: [input.image],
        mainEntityOfPage: input.pageUrl,
        url: input.pageUrl,
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${input.pageUrl}#breadcrumb`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE_URL}/blog/` },
          {
            "@type": "ListItem",
            position: 3,
            name: input.categoryLabel,
            item: input.categoryUrl,
          },
          { "@type": "ListItem", position: 4, name: input.title, item: input.pageUrl },
        ],
      },
    ],
  };
}
