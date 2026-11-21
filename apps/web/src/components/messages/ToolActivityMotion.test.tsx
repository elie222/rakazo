import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ToolSteps } from "./ToolActivityDisclosure";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));

const steps = [
  { label: "Listed folders", count: 1 },
  { label: "Reading notes", count: 2 },
];
const pulse = "motion-safe:animate-[rkPulse_1.2s_ease-in-out_infinite]";

it("uses a motion-safe pulse only for the current tool step", () => {
  const html = renderToStaticMarkup(<ToolSteps steps={steps} currentIndex={1} />);
  const running = html.match(/<span[^>]*>◷<\/span>/)?.[0];
  const completed = html.match(/<span[^>]*>✓<\/span>/)?.[0];

  expect(running).toContain("text-warning");
  expect(running).toContain(pulse);
  expect(running).not.toContain('style="');
  expect(completed).toContain("text-success");
  expect(completed).not.toContain("animate");
  expect(html).toContain("Reading notes ×2");
});

it("leaves all steps static when nothing is current", () => {
  const html = renderToStaticMarkup(<ToolSteps steps={steps} />);
  expect(html.match(/text-success/g)).toHaveLength(2);
  expect(html).not.toContain("rkPulse");
  expect(html).not.toContain("text-warning");
});
