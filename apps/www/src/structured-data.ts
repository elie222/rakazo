import { PRICE_OFFERS } from "./pricing";
import { DISCORD_URL, GITHUB_URL, SITE_NAME, SITE_URL, X_URL } from "./site";

export type FaqItem = {
  question: string;
  answer: string;
};

/** What a post's head says about it: og:type article, its dates and its author's profile URL. */
export type ArticleMeta = { published: Date; modified: Date; authorUrl: string };

const LEGAL_NAME = "Inbox Zero Inc.";

export const ORGANIZATION_ID = `${SITE_URL}/#organization`;
/** Points at the home page's Organization, and names it for readers that see one page alone. */
const ORGANIZATION = {
  "@type": "Organization",
  "@id": ORGANIZATION_ID,
  name: SITE_NAME,
  url: `${SITE_URL}/`,
};
const SOFTWARE_ID = `${SITE_URL}/#software`;

function graph(nodes: readonly object[]) {
  return { "@context": "https://schema.org", "@graph": nodes };
}

/** FAQ answers can carry `code`, **bold** and [links](/path/); structured data wants plain text. */
function plainText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replaceAll("**", "")
    .replaceAll("`", "");
}

export function faqPageNode(faq: readonly FaqItem[], pageUrl?: string) {
  return {
    "@type": "FAQPage",
    ...(pageUrl ? { "@id": `${pageUrl}#faq`, url: pageUrl } : {}),
    mainEntity: faq.map((item) => ({
      "@type": "Question",
      name: plainText(item.question),
      acceptedAnswer: { "@type": "Answer", text: plainText(item.answer) },
    })),
  };
}

export function faqPageSchema(faq: readonly FaqItem[]) {
  return { "@context": "https://schema.org", ...faqPageNode(faq) };
}

/** A step under Home, by its site path, such as `{ name: "Alternatives", path: "/alternatives/" }`. */
export type Crumb = { name: string; path: string };

export function breadcrumbNode(pageUrl: string, crumbs: readonly Crumb[]) {
  return {
    "@type": "BreadcrumbList",
    "@id": `${pageUrl}#breadcrumb`,
    itemListElement: [{ name: "Home", path: "/" }, ...crumbs].map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: new URL(crumb.path, SITE_URL).toString(),
    })),
  };
}

export type ArticleInput = {
  pageUrl: string;
  headline: string;
  description: string;
  /** Crumbs after Home; the last one is this page. */
  crumbs: readonly Crumb[];
  /** ISO dates. A page with no real date leaves them out. */
  published?: string;
  modified?: string;
  image?: string;
  type?: "Article" | "BlogPosting";
  author?: object;
};

/**
 * An article page: the Article, its breadcrumbs, and any nodes the page already had, such as
 * its FAQPage or ItemList. The publisher is the Organization the home page describes.
 */
export function articleStructuredData(input: ArticleInput, ...nodes: readonly object[]) {
  return graph([
    {
      "@type": input.type ?? "Article",
      "@id": `${input.pageUrl}#article`,
      headline: input.headline,
      description: input.description,
      ...(input.published ? { datePublished: input.published } : {}),
      ...(input.modified ? { dateModified: input.modified } : {}),
      author: input.author ?? ORGANIZATION,
      publisher: ORGANIZATION,
      ...(input.image ? { image: [new URL(input.image, SITE_URL).toString()] } : {}),
      mainEntityOfPage: input.pageUrl,
      url: input.pageUrl,
      breadcrumb: { "@id": `${input.pageUrl}#breadcrumb` },
    },
    breadcrumbNode(input.pageUrl, input.crumbs),
    ...nodes,
  ]);
}

function usd(cents: number): string {
  return String(cents / 100);
}

/** Offers built from the plans the pricing page shows. */
export function priceOffers() {
  return PRICE_OFFERS.map((offer) => {
    const base = { "@type": "Offer", name: offer.name, url: `${SITE_URL}/pricing/` };
    if ("fromMonthlyCents" in offer) {
      return {
        ...base,
        description: offer.description,
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          minPrice: usd(offer.fromMonthlyCents),
          priceCurrency: "USD",
          billingDuration: "P1M",
          unitCode: "MON",
        },
      };
    }
    const price = { price: usd(offer.monthlyCents), priceCurrency: "USD" };
    if (offer.monthlyCents === 0) return { ...base, ...price };
    return {
      ...base,
      ...price,
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        ...price,
        billingDuration: "P1M",
        unitCode: "MON",
      },
    };
  });
}

function softwareApplicationNode(extra: object) {
  return {
    "@type": "SoftwareApplication",
    "@id": SOFTWARE_ID,
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "AI agent platform",
    isAccessibleForFree: true,
    codeRepository: GITHUB_URL,
    license: `${GITHUB_URL}/blob/main/LICENSE`,
    provider: ORGANIZATION,
    offers: priceOffers(),
    ...extra,
  };
}

export function pricingStructuredData() {
  return graph([softwareApplicationNode({})]);
}

/** Each platform the download page links to, with the address of its download. */
export function downloadStructuredData(
  platforms: readonly { operatingSystem: string; href: string }[],
) {
  return graph([
    softwareApplicationNode({
      operatingSystem: platforms.map((platform) => platform.operatingSystem).join(", "),
      downloadUrl: platforms.map((platform) => new URL(platform.href, SITE_URL).toString()),
    }),
  ]);
}

export type HomeStructuredDataInput = {
  pageUrl: string;
  title: string;
  description: string;
  siteDescription: string;
  inLanguage: string;
  defaultInLanguage: string;
  availableLanguages: string[];
  faq?: readonly FaqItem[];
};

export function homeStructuredData(input: HomeStructuredDataInput) {
  return graph([
    {
      "@type": "Organization",
      "@id": ORGANIZATION_ID,
      name: SITE_NAME,
      legalName: LEGAL_NAME,
      url: `${SITE_URL}/`,
      logo: `${SITE_URL}/brand/rakazo-mark.png`,
      email: "hello@rakazo.com",
      contactPoint: {
        "@type": "ContactPoint",
        contactType: "customer support",
        email: "hello@rakazo.com",
        url: `${SITE_URL}/support/`,
        availableLanguage: input.availableLanguages,
      },
      address: {
        "@type": "PostalAddress",
        streetAddress: "131 Continental Dr, Suite 305",
        addressLocality: "Newark",
        addressRegion: "DE",
        postalCode: "19713",
        addressCountry: "US",
      },
      sameAs: [GITHUB_URL, X_URL, DISCORD_URL, "https://www.getinboxzero.com/"],
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: `${SITE_URL}/`,
      name: SITE_NAME,
      description: input.siteDescription,
      inLanguage: input.defaultInLanguage,
      publisher: ORGANIZATION,
    },
    {
      "@type": "WebPage",
      "@id": `${input.pageUrl}#webpage`,
      url: input.pageUrl,
      name: input.title,
      description: input.description,
      inLanguage: input.inLanguage,
      isPartOf: { "@id": `${SITE_URL}/#website` },
      about: { "@id": SOFTWARE_ID },
    },
    softwareApplicationNode({
      description: input.siteDescription,
      operatingSystem: "Web, macOS, Windows, Linux, iOS, Android",
      inLanguage: input.availableLanguages,
    }),
    ...(input.faq && input.faq.length > 0 ? [faqPageNode(input.faq, input.pageUrl)] : []),
  ]);
}
