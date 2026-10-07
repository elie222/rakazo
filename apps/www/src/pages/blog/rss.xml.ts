import { getCollection } from "astro:content";
import type { APIRoute } from "astro";
import { SITE_NAME, SITE_URL } from "../../site";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export const GET: APIRoute = async () => {
  const posts = (await getCollection("blog")).sort(
    (a, b) => b.data.published.getTime() - a.data.published.getTime(),
  );
  const items = posts
    .map((post) => {
      const url = `${SITE_URL}/blog/${post.id}/`;
      return `<item>
  <title>${escapeXml(post.data.title)}</title>
  <link>${url}</link>
  <guid>${url}</guid>
  <pubDate>${post.data.published.toUTCString()}</pubDate>
  <description>${escapeXml(post.data.description)}</description>
</item>`;
    })
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${SITE_NAME} blog</title>
  <link>${SITE_URL}/blog/</link>
  <description>Notes on running an open source AI agent yourself.</description>
${items}
</channel>
</rss>
`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
    },
  });
};
