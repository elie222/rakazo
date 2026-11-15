import { describe, expect, it } from "vitest";
import { pageDate } from "./page-dates";
import { PRICING_COMPARISON } from "./pricing";
import {
  ORGANIZATION_ID,
  blogPostStructuredData,
  homeStructuredData,
  pageArticleStructuredData,
  priceOffers,
} from "./structured-data";

type Node = Record<string, unknown>;

/** References that resolve neither to a node in the graph nor to the home page's Organization. */
function unresolvedRefs(graph: readonly object[]): string[] {
  const ids = new Set((graph as readonly Node[]).map((node) => node["@id"]));
  const refs: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length === 1 && entries[0]?.[0] === "@id") refs.push(String(entries[0][1]));
      else for (const [, child] of entries) walk(child);
    }
  };
  walk(graph);
  return refs.filter((ref) => !ids.has(ref) && ref !== ORGANIZATION_ID);
}

function byType(graph: readonly object[], type: string): Node | undefined {
  return (graph as readonly Node[]).find((node) => node["@type"] === type);
}

describe("structured data", () => {
  it("keeps a page's FAQ and other nodes beside its article and breadcrumbs", () => {
    const itemList = { "@type": "ItemList", name: "List" };
    const { "@graph": graph } = pageArticleStructuredData(
      {
        path: "/sandboxes/e2b/",
        headline: "E2B",
        description: "About E2B",
        parents: [{ name: "Sandboxes", path: "/sandboxes/" }],
        faq: [{ question: "Is it **free**?", answer: "See [pricing](/pricing/)." }],
      },
      itemList,
    );
    expect(graph.map((node) => (node as Node)["@type"])).toEqual([
      "Article",
      "BreadcrumbList",
      "ItemList",
      "FAQPage",
    ]);
    expect(byType(graph, "Article")).toMatchObject({
      datePublished: pageDate("/sandboxes/e2b/"),
      dateModified: pageDate("/sandboxes/e2b/"),
      publisher: { "@id": ORGANIZATION_ID },
    });
    expect(byType(graph, "BreadcrumbList")?.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: "https://rakazo.com/" },
      { "@type": "ListItem", position: 2, name: "Sandboxes", item: "https://rakazo.com/sandboxes/" },
      { "@type": "ListItem", position: 3, name: "E2B", item: "https://rakazo.com/sandboxes/e2b/" },
    ]);
    expect(unresolvedRefs(graph)).toEqual([]);
  });

  it("leaves dates out for a page that shows none", () => {
    const { "@graph": graph } = pageArticleStructuredData({
      path: "/self-hosted-ai-agent/",
      headline: "Self-hosted AI agent",
      description: "Run it yourself",
    });
    expect(byType(graph, "Article")).not.toHaveProperty("dateModified");
  });

  it("goes Home > Blog > Post while the post's category is not indexed", () => {
    const input = {
      pageUrl: "https://rakazo.com/blog/post/",
      title: "Post",
      description: "A post",
      published: "2026-10-07",
      updated: "2026-10-24",
      image: "https://rakazo.com/og/post.png",
    };
    const crumbs = (graph: readonly object[]) =>
      (byType(graph, "BreadcrumbList")?.itemListElement as Node[]).map((item) => item.name);
    expect(crumbs(blogPostStructuredData(input)["@graph"])).toEqual(["Home", "Blog", "Post"]);
    const withCategory = blogPostStructuredData({
      ...input,
      category: { name: "Guides", path: "/blog/guides/" },
    });
    expect(crumbs(withCategory["@graph"])).toEqual(["Home", "Blog", "Guides", "Post"]);
    expect(unresolvedRefs(withCategory["@graph"])).toEqual([]);
  });

  it("offers every plan the pricing table shows, at its monthly price", () => {
    const offers = priceOffers() as Node[];
    expect(offers.map((offer) => offer.name)).toEqual(
      PRICING_COMPARISON.columns.map((column) => column.name),
    );
    for (const [index, column] of PRICING_COMPARISON.columns.entries()) {
      const offer = offers[index] as Node;
      if (column.price === "Free") expect(offer.price).toBe("0");
      else if ("price" in offer) expect(column.price).toBe(`$${offer.price}/mo`);
      else expect(column.price).toContain(`$${(offer.priceSpecification as Node).minPrice}`);
    }
  });

  it("describes the Organization once, on home pages", () => {
    const { "@graph": graph } = homeStructuredData({
      pageUrl: "https://rakazo.com/",
      title: "Rakazo",
      description: "AI teammates",
      siteDescription: "AI teammates",
      inLanguage: "en",
      defaultInLanguage: "en",
      availableLanguages: ["en"],
    });
    expect(byType(graph, "Organization")?.["@id"]).toBe(ORGANIZATION_ID);
    expect(unresolvedRefs(graph)).toEqual([]);
  });
});
