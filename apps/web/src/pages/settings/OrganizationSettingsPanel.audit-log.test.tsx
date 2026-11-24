// @vitest-environment jsdom

import type { AuditEvent } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  events: vi.fn(),
  recheckSession: vi.fn(),
  organizations: [] as unknown[],
}));
const uiLocale = vi.hoisted(() =>
  Intl.DateTimeFormat().resolvedOptions().locale.startsWith("de") ? "en" : "de",
);
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    i18n: { locale: uiLocale },
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`,
        "",
      ),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/query/rpc", () => ({
  rpc: { audit: { events: api.events }, organizations: {} },
  selectedSpaceId: () => "space-1",
  withSpaceHeaders: (_init: unknown, spaceId: string | null = "space-1") =>
    new Headers(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
  clearSpaceSelection: vi.fn(),
  selectSpace: vi.fn(),
  recheckSessionOnUnauthorized: api.recheckSession,
}));
vi.mock("../../lib/spaces/organizations", () => ({
  organizationsQuery: () => ({ queryKey: ["organizations"] }),
  useOrganizations: () => ({ organizations: api.organizations, activeOrganizationId: "org-1" }),
}));
vi.mock("../../lib/auth/auth", () => ({ authClient: { $store: { notify: vi.fn() } } }));

import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { QueryUserProvider, queryClient } from "../../lib/query/query";
import type { OrganizationPage } from "./OrganizationSettingsPanel";
import { OrganizationOptionsMenu, OrganizationSettingsPanel } from "./OrganizationSettingsPanel";

/** What the settings page does: the menu in its header, the panel below, one page at a time. */
function Page() {
  const [page, setPage] = useState<OrganizationPage>("main");
  return (
    <>
      <header>
        {page === "main" ? <OrganizationOptionsMenu onActivityLog={() => setPage("log")} /> : null}
      </header>
      <OrganizationSettingsPanel page={page} onPageChange={setPage} />
    </>
  );
}

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

function organization(overrides: Record<string, unknown> = {}) {
  return {
    id: "org-1",
    name: "Work",
    defaultSpaceId: "space-1",
    spaceIds: ["space-1"],
    canManage: true,
    role: "owner",
    memberCount: 3,
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
  api.organizations = [organization()];
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
          <Page />
        </QueryUserProvider>
      </QueryClientProvider>,
    ),
  );
}

async function openMenu() {
  await render();
  await click(container.querySelector('header button[aria-label="Organization options"]')!);
  return [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
}

/** Opens the organization options menu and chooses Activity log. */
async function open() {
  await openMenu();
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
  expect(api.events).toHaveBeenCalledWith({ limit: 50 }, { context: { spaceId: "space-1" } });

  const more = [...log.querySelectorAll("button")].find(
    (button) => button.textContent === "Load more",
  )!;
  await act(async () => more.click());
  await vi.waitFor(() =>
    expect(rowText()).toEqual(expect.arrayContaining(["credential.created", "Ada"])),
  );
  expect(api.events).toHaveBeenLastCalledWith(
    { limit: 50, cursor: "e2" },
    { context: { spaceId: "space-1" } },
  );
  expect(log.textContent).not.toContain("Load more");
  // A normal outcome is not repeated on every row; only an unusual one is shown.
  expect(log.textContent).not.toContain("success");
});

it("keeps the log off the organization page until Activity log is chosen, and Back returns", async () => {
  api.events.mockResolvedValue({ events: [event("e1")], nextCursor: null });
  await render();
  const body = container.querySelector('[data-testid="organization-settings"]')!;
  expect(body).not.toBeNull();
  // The body holds only Name and Members: no options menu, no Delete.
  expect(container.querySelector('button[aria-label="Organization options"]')).not.toBeNull();
  expect(body.querySelector('button[aria-label="Organization options"]')).toBeNull();
  expect([...body.querySelectorAll("button")].map((each) => each.textContent)).toEqual([
    "Members3",
  ]);
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
  // The menu belongs to the main page only.
  expect(container.querySelector('button[aria-label="Organization options"]')).toBeNull();

  await click(log.querySelector('button[aria-label="Back"]')!);
  expect(container.querySelector('[data-testid="audit-log"]')).toBeNull();
  expect(container.querySelector('[data-testid="organization-settings"]')).not.toBeNull();
});

it("offers Delete organization in the header menu only to someone who may delete", async () => {
  expect(await openMenu()).toEqual(["Activity log"]);
  await act(async () => root.unmount());
  root = createRoot(container);
  api.organizations = [
    organization({ memberCount: 1 }),
    organization({ id: "org-2", name: "Home", spaceIds: ["space-2"], memberCount: 1 }),
  ];
  expect(await openMenu()).toEqual(["Activity log", "Delete organization"]);
  expect(
    container.querySelector('[data-testid="organization-settings"]')?.textContent,
  ).not.toContain("Delete");
});

it("shows a failed load on the log page", async () => {
  api.events.mockRejectedValue(new Error("Boom"));
  await open();
  expect(container.querySelector('[data-testid="audit-log"] [role="alert"]')?.textContent).toBe(
    "Boom",
  );
});

it("exports the log with the Space header", async () => {
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

it("reads the log again after a refused export, so a reader who lost access goes back", async () => {
  api.events.mockResolvedValueOnce({ events: [event("e1")], nextCursor: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("no", { status: 401 })),
  );
  await open();
  api.events.mockRejectedValue(Object.assign(new Error("Refused"), { code: "UNAUTHORIZED" }));

  const exportButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Export",
  )!;
  await act(async () => exportButton.click());
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="organization-settings"]')).not.toBeNull(),
  );
  expect(api.recheckSession).toHaveBeenCalledWith(401);
  vi.unstubAllGlobals();
});

it("reads and exports through the organization's own Space, not the one selected in the sidebar", async () => {
  // The selected Space is "space-1"; the organization shown lands in "space-own".
  api.organizations = [organization({ defaultSpaceId: "space-own", spaceIds: ["space-own"] })];
  api.events.mockResolvedValue({ events: [event("e1")], nextCursor: null });
  const fetchMock = vi.fn(async () => new Response("{}\n"));
  vi.stubGlobal("fetch", fetchMock);
  URL.createObjectURL = vi.fn(() => "blob:audit");
  URL.revokeObjectURL = vi.fn();
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await open();

  expect(api.events).toHaveBeenCalledWith({ limit: 50 }, { context: { spaceId: "space-own" } });
  const exportButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Export",
  )!;
  await act(async () => exportButton.click());
  await vi.waitFor(() => expect(anchorClick).toHaveBeenCalled());
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(new Headers(init.headers).get("x-rakazo-space-id")).toBe("space-own");
  vi.unstubAllGlobals();
  anchorClick.mockRestore();
});

it("names what a credential change touched when the event has no target label", async () => {
  api.events.mockResolvedValue({
    events: [
      event("e3", {
        action: "credential.deleted",
        actorType: "user",
        actorLabel: "Ada",
        targetType: "model",
        targetId: null,
        targetLabel: null,
        metadata: { kind: "model", provider: "acme-llm" },
      }),
      event("e2", {
        action: "credential.deleted",
        actorType: "user",
        actorLabel: "Ada",
        targetType: "mcp",
        targetId: null,
        targetLabel: null,
        metadata: { kind: "mcp", id: "server-7" },
      }),
      event("e1", {
        action: "audit_log.exported",
        actorType: "user",
        actorLabel: "Ada",
        targetType: null,
        targetId: null,
        targetLabel: null,
        metadata: {},
      }),
    ],
    nextCursor: null,
  });
  await open();

  const rows = [...container.querySelectorAll('[data-testid="audit-log"] li')].map(
    (row) => row.textContent,
  );
  expect(rows[0]).toContain("model");
  expect(rows[0]).toContain("acme-llm");
  expect(rows[1]).toContain("mcp");
  expect(rows[1]).toContain("server-7");
  // Nothing recorded: the row shows the action and the actor and no empty detail.
  expect(rows[2]).toContain("audit_log.exported");
});

it("names the actor by id when the event has no label, and by type only when it has neither", async () => {
  api.events.mockResolvedValue({
    events: [
      event("e3", { actorType: "user", actorLabel: null, actorId: "user-1" }),
      event("e2", { actorType: "user", actorLabel: "", actorId: "user-2" }),
      event("e1", { actorType: "system", actorLabel: null, actorId: null }),
    ],
    nextCursor: null,
  });
  await open();

  const actors = [...container.querySelectorAll('[data-testid="audit-log"] li')].map(
    (row) => row.querySelector("span.flex > span")?.textContent,
  );
  expect(actors).toEqual(["user-1", "user-2", "system"]);
});

it.each(["FORBIDDEN", "UNAUTHORIZED"])(
  "sends a reader answered %s back to the organization page without an error",
  async (code) => {
    api.events.mockRejectedValue(Object.assign(new Error("Refused"), { code }));
    await open();

    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="organization-settings"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-testid="audit-log"]')).toBeNull();
    expect(container.textContent).not.toContain("Could not load the log.");
  },
);

it("falls back to the target id when the label is empty, and keeps Export off until the log has loaded", async () => {
  const first = deferred<unknown>();
  const entry = event("e1", { targetLabel: "", targetId: "send_email", targetType: "tool" });
  api.events.mockReturnValue(first.promise);
  await open();
  const exportButton = () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Export")!;
  expect(exportButton().disabled).toBe(true);
  await act(async () =>
    first.resolve({
      events: [entry],
      nextCursor: null,
    }),
  );
  await vi.waitFor(() => expect(exportButton().disabled).toBe(false));
  const row = container.querySelector('[data-testid="audit-log"] li')!;
  expect(row.textContent).toContain("send_email");
  const timestamp = row.querySelector("time");
  expect(timestamp?.getAttribute("datetime")).toBe(entry.createdAt);
  expect(timestamp?.textContent).toBe(new Date(entry.createdAt).toLocaleString(uiLocale));
});

it("reads the log again when the window regains focus, so a lost permission shows at once", async () => {
  api.events.mockResolvedValueOnce({ events: [event("e1")], nextCursor: null });
  await open();
  expect(api.events).toHaveBeenCalledTimes(1);

  api.events.mockRejectedValue(Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }));
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await vi.waitFor(() => expect(api.events).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="organization-settings"]')).not.toBeNull(),
  );
  expect(container.querySelector('[data-testid="audit-log"]')).toBeNull();
});

it("keeps Export off while a later read of an already loaded log has failed", async () => {
  api.events.mockResolvedValueOnce({ events: [event("e1")], nextCursor: null });
  await open();
  const exportButton = () =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Export",
    ) as HTMLButtonElement;
  expect(exportButton().disabled).toBe(false);

  api.events.mockRejectedValue(new Error("Boom"));
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Boom"),
  );
  expect(container.querySelector('[data-testid="audit-log"] li')).not.toBeNull();
  expect(exportButton().disabled).toBe(true);
});

it("sends a reader refused while loading an older page back too, and keeps Export off after a failed load", async () => {
  api.events
    .mockResolvedValueOnce({ events: [event("e2")], nextCursor: "e2" })
    .mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }));
  await open();
  const more = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Load more",
  )!;
  await act(async () => more.click());
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="organization-settings"]')).not.toBeNull(),
  );
  expect(container.querySelector('[data-testid="audit-log"]')).toBeNull();

  await act(async () => root.unmount());
  root = createRoot(container);
  api.events.mockReset();
  api.events.mockRejectedValue(new Error("Boom"));
  await open();
  const exportButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Export",
  ) as HTMLButtonElement;
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Boom");
  expect(exportButton.disabled).toBe(true);
});
