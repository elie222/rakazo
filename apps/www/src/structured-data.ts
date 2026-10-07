import { GITHUB_URL, SITE_NAME, SITE_URL } from "./site";

const LEGAL_NAME = "Inbox Zero Inc.";

export type HomeStructuredDataInput = {
  pageUrl: string;
  title: string;
  description: string;
  siteDescription: string;
  inLanguage: string;
  defaultInLanguage: string;
  availableLanguages: string[];
};

export function homeStructuredData(input: HomeStructuredDataInput) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${SITE_URL}/#organization`,
        name: SITE_NAME,
        legalName: LEGAL_NAME,
        url: `${SITE_URL}/`,
        logo: `${SITE_URL}/brand/rakazo-mark.svg`,
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
        sameAs: [GITHUB_URL, "https://www.getinboxzero.com/"],
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        url: `${SITE_URL}/`,
        name: SITE_NAME,
        description: input.siteDescription,
        inLanguage: input.defaultInLanguage,
        publisher: { "@id": `${SITE_URL}/#organization` },
      },
      {
        "@type": "WebPage",
        "@id": `${input.pageUrl}#webpage`,
        url: input.pageUrl,
        name: input.title,
        description: input.description,
        inLanguage: input.inLanguage,
        isPartOf: { "@id": `${SITE_URL}/#website` },
        about: { "@id": `${SITE_URL}/#software` },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${SITE_URL}/#software`,
        name: SITE_NAME,
        url: `${SITE_URL}/`,
        description: input.siteDescription,
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "AI agent platform",
        operatingSystem: "Web, macOS, Linux, iOS, Android",
        isAccessibleForFree: true,
        codeRepository: GITHUB_URL,
        license: `${GITHUB_URL}/blob/main/LICENSE`,
        provider: { "@id": `${SITE_URL}/#organization` },
        inLanguage: input.availableLanguages,
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
        },
      },
    ],
  };
}
