// @vitest-environment jsdom

import type { AuditEvent } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ events: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`,
        "",
      ),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/rpc", () => ({
  rpc: { audit: { events: api.events }, organizations: {} },
  selectedSpaceId: () => "space-1",
  withSpaceHeaders: () => new Headers({ "x-rakazo-space-id": "space-1" }),
  clearSpaceSelection: vi.fn(),
  selectSpace: vi.fn(),
}));
vi.mock("../lib/organizations", () => ({
  organizationsQuery: () => ({ queryKey: ["organizations"] }),
  useOrganizations: () => ({
    organizations: [
      {
        id: "org-1",
        name: "Work",
        defaultSpaceId: "space-1",
        spaceIds: ["space-1"],
        canManage: true,
      },
    ],
    activeOrganizationId: "org-1",
  }),
}));
vi.mock("../lib/auth", () => ({ authClient: { $store: { notify: vi.fn() } } }));

import { QueryClientProvider } from "@tanstack/react-query";
import { QueryUserProvider, queryClient } from "../lib/query";
import { OrganizationSettingsPanel } from "./OrganizationSettingsPanel";

function event(id: string, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id,
    createdAt: "2026-03-02T10:00:00.000Z",
    organizationId: "org-1",
    spaceId: "space-1",
    spaceName: "Main",
    actorType: "bot",
    actorId: "bot-1",
    actorLabel: "Helper",
    action: "tool.call",
    targetType: "tool",
    targetId: "send_email",
    targetLabel: "Send email",
    outcome: "success",
    runId: null,
    threadId: null,
    ip: null,
    userAgent: null,
    metadata: {},
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  api.events.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function click(element: Element) {
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <QueryUserProvider value="user-a">
          <OrganizationSettingsPanel />
        </QueryUserProvider>
      </QueryClientProvider>,
    ),
  );
}

/** Opens the organization options menu and chooses Activity log. */
async function open() {
  await render();
  await click(container.querySelector('button[aria-label="Organization options"]')!);
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent === "Activity log",
    )!,
  );
  await vi.waitFor(() => expect(api.events).toHaveBeenCalled());
  await act(flush);
}

it("lists the organization's audit log and loads older events on request", async () => {
  api.events
    .mockResolvedValueOnce({
      events: [
        event("e2", {
          action: "connection.used",
          actorLabel: "Helper",
          targetLabel: "Calendar",
          outcome: "denied",
          metadata: { connectorId: "calendar", connectionId: "conn-9" },
        }),
      ],
      nextCursor: "e2",
    })
    .mockResolvedValueOnce({
      events: [event("e1", { actorLabel: "Ada", actorType: "user", action: "credential.created" })],
      nextCursor: null,
    });
  await open();

  const log = container.querySelector('[data-testid="audit-log"]')!;
  const rowText = () => [...log.querySelectorAll("li span")].map((span) => span.textContent);
  expect(rowText()).toEqual(
    expect.arrayContaining([
      "connection.used",
      "denied",
      "Helper",
      "Calendar",
      "calendar",
      "conn-9",
    ]),
  );
  expect(log.textContent).not.toContain("·");
  expect(api.events).toHaveBeenCalledWith({ limit: 50 });

  const more = [...log.querySelectorAll("button")].find(
    (button) => button.textContent === "Load more",
  )!;
  await act(async () => more.click());
  await vi.waitFor(() =>
    expect(rowText()).toEqual(expect.arrayContaining(["credential.created", "Ada"])),
  );
  expect(api.events).toHaveBeenLastCalledWith({ limit: 50, cursor: "e2" });
  expect(log.textContent).not.toContain("Load more");
  // A normal outcome is not repeated on every row; only an unusual one is shown.
  expect(log.textContent).not.toContain("success");
});

it("keeps the log off the organization page until Activity log is chosen, and Back returns", async () => {
  api.events.mockResolvedValue({ events: [event("e1")], nextCursor: null });
  await render();
  expect(container.querySelector('[data-testid="organization-settings"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="audit-log"]')).toBeNull();
  expect(api.events).not.toHaveBeenCalled();

  await open();
  const log = container.querySelector('[data-testid="audit-log"]')!;
  expect(container.querySelector('[data-testid="organization-settings"]')).toBeNull();
  expect(log.querySelector("h3")?.textContent).toBe("Activity log");
  const labels = [...log.querySelectorAll("button")].map(
    (button) => button.getAttribute("aria-label") ?? button.textContent,
  );
  expect(labels).toEqual(expect.arrayContaining(["Back", "Export"]));

  await click(log.querySelector('button[aria-label="Back"]')!);
  expect(container.querySelector('[data-testid="audit-log"]')).toBeNull();
  expect(container.querySelector('[data-testid="organization-settings"]')).not.toBeNull();
});

it("shows a failed load on the log page", async () => {
  api.events.mockRejectedValue(new Error("Boom"));
  await open();
  expect(container.querySelector('[data-testid="audit-log"] [role="alert"]')?.textContent).toBe(
    "Boom",
  );
});

it("exports the log of the selected Space", async () => {
  api.events.mockResolvedValue({ events: [event("e1")], nextCursor: null });
  const fetchMock = vi.fn(
    async () =>
      new Response("{}\n", {
        headers: {
          "content-disposition": 'attachment; filename="rakazo-audit-log-2026-01-01.jsonl"',
        },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  URL.createObjectURL = vi.fn(() => "blob:audit");
  URL.revokeObjectURL = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await open();

  const exportButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Export",
  )!;
  await act(async () => exportButton.click());
  await vi.waitFor(() => expect(click).toHaveBeenCalled());

  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/audit-events/export");
  expect(new Headers(init.headers).get("x-rakazo-space-id")).toBe("space-1");
  vi.unstubAllGlobals();
  click.mockRestore();
});

it("says so when the export fails", async () => {
  api.events.mockResolvedValue({ events: [event("e1")], nextCursor: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("no", { status: 500 })),
  );
  await open();

  const exportButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Export",
  )!;
  await act(async () => exportButton.click());
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not export the log.",
    ),
  );
  vi.unstubAllGlobals();
});
