// @vitest-environment jsdom

import type { AuditEvent } from "@rakazo/contracts";
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
vi.mock("../components/CreateOrganizationDialog", () => ({ CreateOrganizationDialog: () => null }));
vi.mock("../lib/auth", () => ({ authClient: { $store: { notify: vi.fn() } } }));

import { queryClient } from "../lib/query";
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
  api.events.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function open() {
  await act(async () => root.render(<OrganizationSettingsPanel />));
  await vi.waitFor(() => expect(api.events).toHaveBeenCalled());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
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
  expect(log.textContent).toContain("Helper · connection.used");
  expect(log.textContent).toContain("denied");
  expect(log.textContent).toContain("Calendar · calendar · conn-9");
  expect(log.querySelector("a")?.getAttribute("href")).toBe("/api/audit-events/export");
  expect(api.events).toHaveBeenCalledWith({ limit: 50 });

  const more = [...log.querySelectorAll("button")].find(
    (button) => button.textContent === "Load more",
  )!;
  await act(async () => more.click());
  await vi.waitFor(() => expect(log.textContent).toContain("Ada · credential.created"));
  expect(api.events).toHaveBeenLastCalledWith({ limit: 50, cursor: "e2" });
  expect(log.textContent).not.toContain("Load more");
  // A normal outcome is not repeated on every row; only an unusual one is shown.
  expect(log.textContent).not.toContain("success");
});

it("hides the log from members the server does not let read it", async () => {
  api.events.mockRejectedValue(Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }));
  await open();
  expect(container.querySelector('[data-testid="organization-settings"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="audit-log"]')).toBeNull();
});
