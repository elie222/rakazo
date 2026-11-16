// @vitest-environment jsdom

import type { BillingStatus } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.flatMap((part, index) => [part, values[index] ?? ""]).join("");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children?: ReactNode }) => children,
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
import { ModelCreditsSettings } from "./ModelCredits";

const ownKeyTrial: BillingStatus = {
  access: true,
  funding: "byok",
  state: "trialing",
  canManage: true,
  creditPurchasesEnabled: true,
  byokPriceCents: 2000,
  balanceUsd: 0,
  monthlyAmountCents: null,
  cancelAtPeriodEnd: false,
  trialAvailable: false,
  trialDays: 7,
  price: null,
  seats: 1,
  trialEndsAt: null,
  currentPeriodEndsAt: null,
  hasCustomer: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function render(status: BillingStatus) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const portal = vi.fn(async (_input?: unknown) => ({ url: "https://portal.example/flow" }));
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <ModelCreditsSettings
        status={status}
        refresh={async () => {}}
        client={{ billing: { portal } } as unknown as RpcClient}
      />,
    );
    await flush();
  });
  const press = async (label: string) => {
    const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
    expect(found, `button ${label}`).toBeDefined();
    await act(async () => {
      found!.click();
      await flush();
    });
  };
  const has = (label: string) =>
    [...container.querySelectorAll("button")].some((b) => b.textContent === label);
  return { container, portal, assign, press, has };
}

it("lets the owner cancel a trial in the portal's cancel flow", async () => {
  const { portal, assign, press, has } = await render(ownKeyTrial);
  expect(has("Cancel plan")).toBe(false);
  await press("Cancel trial");
  expect(portal).toHaveBeenCalledWith({ intent: "cancel" });
  expect(assign).toHaveBeenCalledWith("https://portal.example/flow");
});

it("lets the owner cancel an active plan", async () => {
  const { portal, press } = await render({ ...ownKeyTrial, state: "active" });
  await press("Cancel plan");
  expect(portal).toHaveBeenCalledWith({ intent: "cancel" });
});

it("offers no cancel once the plan is set to end", async () => {
  const { has } = await render({ ...ownKeyTrial, cancelAtPeriodEnd: true });
  expect(has("Cancel trial")).toBe(false);
  expect(has("Cancel plan")).toBe(false);
});

it("tells a member that only the owner manages billing", async () => {
  const { container, has } = await render({ ...ownKeyTrial, canManage: false });
  expect(container.textContent).toContain(
    "Only the organization owner can change or cancel billing.",
  );
  expect(has("Cancel trial")).toBe(false);
});

it("tells an owner on the free plan that nothing will be charged", async () => {
  const { container } = await render({
    ...ownKeyTrial,
    state: "none",
    hasCustomer: false,
    byokPriceCents: null,
  });
  expect(container.textContent).toContain("No payment method on file. Nothing will be charged.");
});

it("says neither to an owner with a plan", async () => {
  const { container } = await render(ownKeyTrial);
  expect(container.textContent).not.toContain("Only the organization owner");
  expect(container.textContent).not.toContain("Nothing will be charged");
});
