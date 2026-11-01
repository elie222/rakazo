import { renderToStaticMarkup } from "react-dom/server";
import { it } from "vitest";
import { ChatMarkdown } from "./markdown.web";
it("probe", () => {
  const t = "[foo\nbar]: https://example.com/\n\nSee [foo bar].\n\nEnd.\n\nReally.";
  const w = renderToStaticMarkup(<ChatMarkdown>{t}</ChatMarkdown>).includes("example.com");
  const s = renderToStaticMarkup(<ChatMarkdown streaming>{t}</ChatMarkdown>).includes("example.com");
  throw new Error(`RESULT whole=${w} stream=${s}`);
});
