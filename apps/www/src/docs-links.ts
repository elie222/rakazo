import { DOCS_SLUGS, docsPath } from "./docs";
import { GITHUB_URL } from "./site";

const REPO = new URL("https://repo.invalid/");
const MARKDOWN_LINK = /(\]\()([^)\s]+)(\))/g;

/** Resolves a repo doc's relative links: published docs become site pages, any other file opens on GitHub. */
export function rewriteDocsLinks(markdown: string, slug: string): string {
  const source = new URL(`docs/${slug}.md`, REPO);
  return markdown.replace(MARKDOWN_LINK, (match, open: string, href: string, close: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return match;
    const target = new URL(href, source);
    if (target.origin !== REPO.origin) return match;
    const doc = /^\/docs\/([\w-]+)\.md$/.exec(target.pathname)?.[1];
    const resolved =
      doc && DOCS_SLUGS.includes(doc)
        ? `${docsPath(doc)}${target.hash}`
        : `${GITHUB_URL}/blob/main${target.pathname}${target.hash}`;
    return `${open}${resolved}${close}`;
  });
}
