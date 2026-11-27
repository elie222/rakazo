// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { flush } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueryRoot as createRoot } from "../../lib/query/query-root.test-support";

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.flatMap((part, index) => [part, values[index] ?? ""]).join("");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children?: ReactNode }) => children,
    Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
      <>{value === 1 ? one : other}</>
    ),
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Button = ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  );
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button,
    Skeleton: (props: ComponentProps<"div">) => <div {...props} />,
    SectionHeading: Container,
    Card: Container,
    CardContent: Container,
    CardFooter: Container,
    CardHeader: Container,
    AlertDialog: Container,
    AlertDialogAction: Button,
    AlertDialogCancel: Button,
    AlertDialogContent: Container,
    AlertDialogDescription: Container,
    AlertDialogFooter: Container,
    AlertDialogHeader: Container,
    AlertDialogTitle: Container,
    Dialog: Container,
    DialogContent: Container,
    DialogDescription: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    Select: Container,
    SelectContent: Container,
    SelectGroup: Container,
    SelectItem: Container,
    SelectTrigger: Container,
    SelectValue: Container,
    ToggleGroup: Container,
    ToggleGroupItem: Button,
  };
});

import type { RpcClient } from "../../lib/query/rpc";
import { createSpaceRpc } from "../../lib/query/rpc";
import { SpaceRpcProvider } from "../../lib/query/space-rpc";
import { BillingSettingsPanel } from "./BillingSettingsPanel";

/** A trialing own-key plan whose trial can be ended from the panel. */
const status = {
  funding: "byok",
  state: "trialing",
  canManage: true,
  creditPurchasesEnabled: true,
  byokPriceCents: 2000,
  balanceUsd: 0,
  monthlyAmountCents: null,
  computerHoursLeft: 2,
  cancelAtPeriodEnd: false,
  trialAvailable: false,
};

const requests: Array<{ url: string; spaceId: string | null }> = [];
let trialEnded = false;

beforeEach(() => {
  i18n.activate("en");
  trialEnded = false;
  localStorage.setItem("rakazo:space-id", "space-a");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request, init?: RequestInit) => {
      requests.push({
        url: request.url,
        spaceId: new Headers(init?.headers ?? request.headers).get("x-rakazo-space-id"),
      });
      if (request.url.endsWith("/billing/endTrial")) {
        trialEnded = true;
        return Response.json({ json: {} });
      }
      if (request.url.endsWith("/billing/computerUsage")) {
        return Response.json({
          json: {
            computers: [],
            otherHours: trialEnded ? 0 : 1,
          },
        });
      }
      return Response.json({
        json: trialEnded ? { ...status, state: "active", computerHoursLeft: 25 } : status,
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  requests.length = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

/** The shell binds its window's space, which is what `client` names. */
function panel(client: RpcClient, spaceId: string) {
  return (
    <SpaceRpcProvider spaceId={spaceId}>
      <BillingSettingsPanel client={client} />
    </SpaceRpcProvider>
  );
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}

it("sends the panel's confirmations to the space it opened for", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(panel(createSpaceRpc("space-a"), "space-a"));
    await flush();
  });

  // The panel loaded this organization's status.
  expect(requests[0]).toMatchObject({
    url: expect.stringContaining("/billing/status"),
    spaceId: "space-a",
  });

  // Another tab selects another organization while this panel stays open.
  await vi.waitFor(() => expect(container.textContent).toContain("Hours by computer"));
  localStorage.setItem("rakazo:space-id", "space-b");
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: "rakazo:space-id" }));
  });

  await act(async () => {
    button(container, "Hours by computer").click();
    await flush();
  });
  await vi.waitFor(() => expect(container.textContent).toContain("Other computers"));

  await act(async () => {
    button(container, "Start plan now").click();
  });
  // The confirmation quotes the price the panel loaded, not the new organization's.
  expect(container.textContent).toMatch(/charged \$20(\.00)? today/);
  await act(async () => {
    button(container, "Start plan").click();
    await flush();
  });

  const endTrial = requests.find(({ url }) => url.endsWith("/billing/endTrial"));
  expect(endTrial).toMatchObject({ spaceId: "space-a" });
  await vi.waitFor(() => expect(container.textContent).toContain("No computer hours used yet"));
  const usageReads = requests.filter(({ url }) => url.endsWith("/billing/computerUsage"));
  expect(usageReads.map(({ spaceId }) => spaceId)).toEqual(["space-a", "space-a"]);
  act(() => root.unmount());
  container.remove();
});

it("acts on the window's space when another tab switched before the panel opened", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // This window shows space-a; another tab selected space-b before Billing opened here.
  const client = createSpaceRpc("space-a");
  localStorage.setItem("rakazo:space-id", "space-b");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(panel(client, "space-a"));
    await flush();
  });
  expect(requests[0]).toMatchObject({
    url: expect.stringContaining("/billing/status"),
    spaceId: "space-a",
  });

  await vi.waitFor(() => expect(container.textContent).toContain("Start plan now"));
  await act(async () => {
    button(container, "Start plan now").click();
  });
  await act(async () => {
    button(container, "Start plan").click();
    await flush();
  });
  const endTrial = requests.find(({ url }) => url.endsWith("/billing/endTrial"));
  expect(endTrial).toMatchObject({ spaceId: "space-a" });
  act(() => root.unmount());
  container.remove();
});

it("opens the billing portal of the window's space, and says so when it cannot", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const managed = { state: "active", canManage: true, hasCustomer: true, seats: 1 };
  let portalFails = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request, init?: RequestInit) => {
      requests.push({
        url: request.url,
        spaceId: new Headers(init?.headers ?? request.headers).get("x-rakazo-space-id"),
      });
      if (request.url.endsWith("/billing/portal") && portalFails)
        return Response.json({ json: { message: "down" } }, { status: 500 });
      return Response.json({
        json: request.url.endsWith("/billing/portal") ? { url: "about:blank#portal" } : managed,
      });
    }),
  );
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  localStorage.setItem("rakazo:space-id", "space-b");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(panel(createSpaceRpc("space-a"), "space-a"));
    await flush();
  });

  await vi.waitFor(() => expect(container.textContent).toContain("Manage"));
  await act(async () => {
    button(container, "Manage").click();
    await flush();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not open billing");
  expect(button(container, "Manage").disabled).toBe(false);

  portalFails = false;
  await act(async () => {
    button(container, "Manage").click();
    await flush();
  });
  expect(assign).toHaveBeenCalledExactlyOnceWith("about:blank#portal");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(requests.filter(({ url }) => url.endsWith("/billing/portal"))).toEqual([
    expect.objectContaining({ spaceId: "space-a" }),
    expect.objectContaining({ spaceId: "space-a" }),
  ]);
  act(() => root.unmount());
  container.remove();
});

it("keeps showing loaded billing if a later refresh fails", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const client = createSpaceRpc("space-a");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  root.queryClient.setDefaultOptions({ queries: { retry: false } });
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ json: { state: "active", canManage: false, hasCustomer: true, seats: 1 } }),
    );
  vi.stubGlobal("fetch", fetch);
  await act(async () => root.render(panel(client, "space-a")));
  await vi.waitFor(() => expect(container.textContent).toContain("Active"));
  fetch.mockResolvedValueOnce(Response.json({ json: { message: "down" } }, { status: 500 }));
  await act(async () => {
    await root.queryClient.refetchQueries();
    await flush();
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Active");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  act(() => root.unmount());
  container.remove();
});

const assign = vi.fn();

async function renderPanelWithStatus(nextStatus: Record<string, unknown>, portalReject = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const portalBodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request, init?: RequestInit) => {
      requests.push({
        url: request.url,
        spaceId: new Headers(init?.headers ?? request.headers).get("x-rakazo-space-id"),
      });
      if (request.url.endsWith("/billing/portal")) {
        const text = typeof init?.body === "string" ? init.body : await request.clone().text();
        portalBodies.push(text ? JSON.parse(text) : undefined);
        if (portalReject) return Response.json({ json: { message: "down" } }, { status: 500 });
        return Response.json({ json: { url: "about:blank#portal" } });
      }
      return Response.json({ json: nextStatus });
    }),
  );
  assign.mockReset();
  vi.stubGlobal("location", { ...window.location, assign });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(panel(createSpaceRpc("space-a"), "space-a"));
    await flush();
  });
  return {
    container,
    portalBodies,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

it("renders a single Cancel trial button for non-own-key trials with computer hours and requests cancel flow", async () => {
  const view = await renderPanelWithStatus({
    ...status,
    byokPriceCents: null,
    hasCustomer: true,
    computerHoursLeft: 4,
  });
  await vi.waitFor(() => expect(view.container.textContent).toContain("Cancel trial"));
  const cancelButtons = [...view.container.querySelectorAll("button")].filter(
    (candidate) => candidate.textContent === "Cancel trial",
  );
  expect(cancelButtons).toHaveLength(1);
  await act(async () => {
    cancelButtons[0]!.click();
    await flush();
  });
  expect(assign).toHaveBeenCalledWith("about:blank#portal");
  expect(view.portalBodies[0]).toEqual({ json: { flow: "cancel" } });
  await act(async () => {
    button(view.container, "Manage billing").click();
    await flush();
  });
  expect(view.portalBodies[1]).toEqual({});
  view.cleanup();
});

it("lets owners cancel an active recurring credits plan with cancel flow", async () => {
  const view = await renderPanelWithStatus({
    ...status,
    funding: "credits",
    state: "active",
    hasCustomer: true,
    monthlyAmountCents: 2000,
    byokPriceCents: null,
  });
  await vi.waitFor(() => expect(view.container.textContent).toContain("Cancel plan"));
  await act(async () => {
    button(view.container, "Cancel plan").click();
    await flush();
  });
  expect(view.portalBodies[0]).toEqual({ json: { flow: "cancel" } });
  view.cleanup();
});

it("tells owners when a free own-key period has no payment method", async () => {
  const view = await renderPanelWithStatus({
    ...status,
    state: "trialing",
    hasCustomer: false,
    byokFreeUntil: "2027-01-01T00:00:00.000Z",
    byokPriceCents: 2000,
  });
  await vi.waitFor(() =>
    expect(view.container.textContent).toContain(
      "No payment method on file. Nothing will be charged.",
    ),
  );
  expect(view.container.textContent).not.toContain("Cancel trial");
  view.cleanup();
});

it("tells non-owners who can change or cancel credit billing", async () => {
  const view = await renderPanelWithStatus({
    ...status,
    canManage: false,
    hasCustomer: true,
  });
  await vi.waitFor(() =>
    expect(view.container.textContent).toContain(
      "Only the organization owner can change or cancel billing.",
    ),
  );
  expect(view.container.textContent).not.toContain("Cancel trial");
  view.cleanup();
});

it("requests cancel flow when an owner cancels a seat-based plan", async () => {
  const ownerView = await renderPanelWithStatus({
    state: "active",
    canManage: true,
    hasCustomer: true,
    seats: 1,
  });
  await vi.waitFor(() => expect(ownerView.container.textContent).toContain("Cancel plan"));
  await act(async () => {
    button(ownerView.container, "Cancel plan").click();
    await flush();
  });
  expect(ownerView.portalBodies[0]).toEqual({ json: { flow: "cancel" } });
  ownerView.cleanup();
});

it("tells non-owners who can change or cancel seat-based billing", async () => {
  const memberView = await renderPanelWithStatus({
    state: "active",
    canManage: false,
    hasCustomer: true,
    seats: 1,
  });
  await vi.waitFor(() =>
    expect(memberView.container.textContent).toContain(
      "Only the organization owner can change or cancel billing.",
    ),
  );
  expect(memberView.container.textContent).not.toContain("Cancel plan");
  memberView.cleanup();
});
