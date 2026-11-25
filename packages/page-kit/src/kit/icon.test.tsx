import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Metrics, Properties, Rows, Steps } from "./data.js";
import { Icon } from "./icon.js";
import { Callout } from "./layout.js";
import { LinkCards } from "./text.js";

const html = (element: React.ReactElement) => renderToStaticMarkup(element);

it("draws nothing for a name outside the set, including object keys", () => {
  expect(html(<Icon name="plane" />)).toContain("<path");
  expect(html(<Icon name="airplane" />)).toBe("");
  expect(html(<Icon name="toString" />)).toBe("");
});

it("names an icon only when given a label", () => {
  expect(html(<Icon name="plane" />)).toContain('aria-hidden="true"');
  const labelled = html(<Icon name="plane" label="Flight" />);
  expect(labelled).toContain('role="img"');
  expect(labelled).toContain('aria-label="Flight"');
  expect(labelled).not.toContain("aria-hidden");
});

it("mirrors only icons that point along the reading direction", () => {
  expect(html(<Icon name="arrow-right" />)).toContain("data-mirror");
  expect(html(<Icon name="plane" />)).not.toContain("data-mirror");
});

it("draws an item's icon before its label and leaves unknown ones out", () => {
  const markup = html(
    <>
      <Metrics metrics={[{ value: "3", label: "Nights", icon: "bed" }]} />
      <Steps steps={[{ title: "Fly", icon: "plane" }]} />
      <Rows rows={[{ title: "Hotel", icon: "hotel" }]} />
      <Properties items={[{ label: "Address", value: "x", icon: "map-pin" }]} />
      <Callout lead="Passport" tone="warning" icon="luggage" />
      <LinkCards links={[{ title: "Guide", icon: "globe" }]} />
    </>,
  );
  expect(markup.match(/class="lucide lucide-[a-z-]+ rk-icon"/g)).toHaveLength(6);
  expect(markup).toMatch(/rk-glyph"><svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg><\/span>Nights/);
  expect(markup).not.toContain("rk-callout-icon");
  const unknown = html(
    <>
      <Steps steps={[{ title: "Fly", icon: "airplane" }]} />
      <Rows rows={[{ title: "Hotel", icon: "inn" }]} />
      <Callout lead="Passport" tone="warning" icon="inn" />
    </>,
  );
  expect(unknown).not.toContain("rk-icon");
  expect(unknown).not.toContain("data-leads");
  expect(unknown).toContain("rk-callout-icon");
});
