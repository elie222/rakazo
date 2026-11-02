type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

type VisitorContext = { replaceNode(node: HastNode, replacement: HastNode): void };

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][^\S\n]*(?:\n|$)/;

const ICON_PATHS: Record<string, string[]> = {
  note: ["M12 16v-4", "M12 8h.01", "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z"],
  tip: [
    "M9 18h6",
    "M10 22h4",
    "M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14",
  ],
  important: [
    "M12 7v4",
    "M12 15h.01",
    "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  ],
  warning: [
    "M12 9v4",
    "M12 17h.01",
    "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
  ],
  caution: ["M12 8v4", "M12 16h.01", "M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86L7.86 2z"],
};

const element = (
  tagName: string,
  properties: Record<string, unknown>,
  children: HastNode[] = [],
): HastNode => ({ type: "element", tagName, properties, children });

/** Renders GitHub alert blockquotes (`> [!NOTE]`) as callouts, so the docs read the same here and on GitHub. */
function toCallout(blockquote: HastNode): HastNode | undefined {
  const children = blockquote.children ?? [];
  const index = children.findIndex((child) => child.type === "element");
  const paragraph = children[index];
  const [first, ...rest] = paragraph?.tagName === "p" ? (paragraph.children ?? []) : [];
  const match = first?.type === "text" ? ALERT.exec(first.value ?? "") : null;
  if (!paragraph || !first || !match) return undefined;

  const kind = match[1].toLowerCase();
  const remainder = (first.value ?? "").slice(match[0].length);
  const lead = [...(remainder ? [{ ...first, value: remainder }] : []), ...rest];
  if (lead[0]?.tagName === "br") lead.shift();
  const body = [
    ...(lead.length > 0 ? [{ ...paragraph, children: lead }] : []),
    ...children.slice(index + 1),
  ];

  return element("div", { className: ["docs-callout", `docs-callout--${kind}`], role: "note" }, [
    element(
      "svg",
      { className: ["docs-callout__icon"], viewBox: "0 0 24 24", ariaHidden: "true" },
      ICON_PATHS[kind].map((d) => element("path", { d })),
    ),
    element("div", { className: ["docs-callout__body"] }, body),
  ]);
}

export const docsCallouts = {
  name: "docs-callouts",
  element: {
    filter: ["blockquote"],
    visit(node: HastNode, ctx: VisitorContext) {
      const callout = toCallout(node);
      if (callout) ctx.replaceNode(node, callout);
    },
  },
};
