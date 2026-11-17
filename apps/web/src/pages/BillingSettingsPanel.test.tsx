// @vitest-environment jsdom

import { flush } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueryRoot as createRoot } from "../lib/query-root.test-support";

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

import type { RpcClient } from "../lib/rpc";
import { createSpaceRpc } from "../lib/rpc";
import { SpaceRpcProvider } from "../lib/space-rpc";
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

beforeEach(() => {
  localStorage.setItem("rakazo:space-id", "space-a");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request, init?: RequestInit) => {
      requests.push({
        url: request.url,
        spaceId: new Headers(init?.headers ?? request.headers).get("x-rakazo-space-id"),
      });
      return Response.json({
        json: request.url.endsWith("/billing/endTrial") ? {} : status,
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
  localStorage.setItem("rakazo:space-id", "space-b");
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: "rakazo:space-id" }));
  });

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

/** A provider without model credits: the status carries no `funding`, so this panel is the page. */
const legacy = {
  state: "trialing",
  canManage: true,
  hasCustomer: true,
  cancelAtPeriodEnd: false,
  seats: 1,
};

async function legacyPanel(
  next: Record<string, unknown>,
  portal?: (body: unknown) => Response | Promise<Response>,
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let current = next;
  const portalBodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      if (request.url.endsWith("/billing/portal")) {
        const body = await request.json();
        portalBodies.push(body);
        return (
          (await portal?.(body)) ?? Response.json({ json: { url: "https://portal.example/flow" } })
        );
      }
      return Response.json({ json: current });
    }),
  );
  const assign = vi.fn();
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
    assign,
    portalBodies,
    setStatus: (value: Record<string, unknown>) => {
      current = value;
    },
    has: (label: string) =>
      [...container.querySelectorAll("button")].some(
        (candidate) => candidate.textContent === label,
      ),
    press: async (label: string) => {
      await act(async () => {
        button(container, label).click();
        await flush();
      });
    },
    done: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

it("offers an owner of a plan without model credits Cancel trial, in the cancel flow", async () => {
  const view = await legacyPanel(legacy);
  expect(view.has("Cancel plan")).toBe(false);
  await view.press("Cancel trial");
  expect(view.portalBodies).toEqual([{ json: { intent: "cancel" } }]);
  expect(view.assign).toHaveBeenCalledExactlyOnceWith("https://portal.example/flow");
  view.done();
});

it("offers Cancel plan on an active plan, and none once it is set to end", async () => {
  const active = await legacyPanel({ ...legacy, state: "active" });
  expect(active.has("Cancel plan")).toBe(true);
  active.done();
  const ending = await legacyPanel({ ...legacy, state: "active", cancelAtPeriodEnd: true });
  expect(ending.has("Cancel plan")).toBe(false);
  expect(ending.has("Cancel trial")).toBe(false);
  expect(ending.has("Manage")).toBe(true);
  ending.done();
});

it("explains billing to a member and to an owner with no customer, and no one else", async () => {
  const member = await legacyPanel({ ...legacy, canManage: false });
  expect(member.container.textContent).toContain(
    "Only the organization owner can change or cancel billing.",
  );
  expect(member.has("Cancel trial")).toBe(false);
  member.done();
  const free = await legacyPanel({ ...legacy, state: "none", hasCustomer: false });
  expect(free.container.textContent).toContain(
    "No payment method on file. Nothing will be charged.",
  );
  free.done();
  const owner = await legacyPanel(legacy);
  expect(owner.container.textContent).not.toContain("Only the organization owner");
  expect(owner.container.textContent).not.toContain("Nothing will be charged");
  owner.done();
});

it("re-reads the status when the server finds no plan to cancel, and shows no error", async () => {
  const view = await legacyPanel(legacy, () =>
    Response.json(
      { json: { defined: false, code: "NO_PLAN_TO_CANCEL", status: 409, message: "No plan" } },
      { status: 409 },
    ),
  );
  view.setStatus({ ...legacy, cancelAtPeriodEnd: true });
  await view.press("Cancel trial");
  expect(view.has("Cancel trial")).toBe(false);
  expect(view.assign).not.toHaveBeenCalled();
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  view.done();
});

it("shows the usual error, and keeps the button, when billing is busy", async () => {
  const view = await legacyPanel(legacy, () =>
    Response.json(
      { json: { defined: false, code: "CONFLICT", status: 409, message: "Billing is busy" } },
      { status: 409 },
    ),
  );
  await view.press("Cancel trial");
  expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not open billing",
  );
  expect(view.has("Cancel trial")).toBe(true);
  expect(view.assign).not.toHaveBeenCalled();
  view.done();
});
