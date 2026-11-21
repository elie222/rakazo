// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./components/ui/empty-state.js";
import { InlineError } from "./components/ui/inline-error.js";
import {
  ListRow,
  ListRowAvatar,
  ListRowContent,
  ListRowDescription,
  ListRowLink,
  ListRowStatus,
  ListRowTitle,
  RowActions,
} from "./components/ui/list-row.js";
import { ListSkeleton } from "./components/ui/list-skeleton.js";

function render(node: React.ReactNode) {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, root };
}

describe("ListRow", () => {
  it("keeps actions outside the link and marks the active row", () => {
    const { host, root } = render(
      <ListRow
        active
        actions={
          <RowActions>
            <button type="button">Pin</button>
          </RowActions>
        }
      >
        <ListRowLink href="/chat">
          <ListRowAvatar>L</ListRowAvatar>
          <ListRowContent>
            <ListRowTitle unread>Leon</ListRowTitle>
            <ListRowDescription>Ready</ListRowDescription>
          </ListRowContent>
          <ListRowStatus working />
        </ListRowLink>
      </ListRow>,
    );
    const row = host.querySelector('[data-slot="list-row"]')!;
    const link = row.querySelector('[data-slot="list-row-link"]')!;
    const actions = row.querySelector('[data-slot="row-actions"]')!;

    expect(row.getAttribute("data-active")).toBe("true");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.contains(actions)).toBe(false);
    expect(link.getAttribute("href")).toBe("/chat");
    expect(host.querySelector('[data-slot="list-row-title"]')?.getAttribute("data-unread")).toBe(
      "true",
    );
    expect(host.querySelector('[data-slot="list-row-status"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("renders no status element when there is nothing to say", () => {
    const { host, root } = render(<ListRowStatus />);
    expect(host.querySelector('[data-slot="list-row-status"]')).toBeNull();
    act(() => root.unmount());
  });

  it("marks only the current row as the page, not a drag target", () => {
    const { host, root } = render(
      <ListRow active current={false}>
        <ListRowLink href="/drop-target">Drop here</ListRowLink>
      </ListRow>,
    );
    expect(host.querySelector('[data-slot="list-row"]')?.getAttribute("data-active")).toBe("true");
    expect(host.querySelector('[data-slot="list-row-link"]')?.getAttribute("aria-current")).toBe(
      null,
    );
    act(() => root.unmount());
  });

  it("announces its status when given a localized label", () => {
    const { host, root } = render(<ListRowStatus working label="Running" />);
    expect(host.querySelector('[data-slot="list-row-status"]')?.textContent).toContain("Running");
    act(() => root.unmount());
  });

  it("uses the page surface instead of sidebar colors when asked", () => {
    const { host, root } = render(
      <ListRow tone="surface">
        <ListRowLink href="/run">Run</ListRowLink>
      </ListRow>,
    );
    expect(host.querySelector('[data-slot="list-row"]')?.className).toContain("hover:bg-accent");
    expect(host.querySelector('[data-slot="list-row"]')?.className).not.toContain("sidebar-accent");
    act(() => root.unmount());
  });
});

describe("list foundations", () => {
  it("renders one skeleton row per requested row", () => {
    const { host, root } = render(<ListSkeleton rows={3} />);
    expect(host.querySelectorAll('[data-slot="list-skeleton"] > div')).toHaveLength(3);
    expect(host.querySelector('[data-slot="list-skeleton"]')?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    act(() => root.unmount());
  });

  it("keeps an empty state to its title and action", () => {
    const { host, root } = render(
      <EmptyState title="Nothing yet" action={<button type="button">Create</button>} />,
    );
    expect(host.textContent).toContain("Nothing yet");
    expect(host.querySelector("button")?.textContent).toBe("Create");
    act(() => root.unmount());
  });

  it("announces an inline failure and its action", () => {
    const { host, root } = render(
      <InlineError message="Could not load" action={<button type="button">Retry</button>} />,
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
    expect(host.querySelector("button")?.textContent).toBe("Retry");
    act(() => root.unmount());
  });
});
