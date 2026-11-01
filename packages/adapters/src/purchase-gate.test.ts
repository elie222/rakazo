import type { BrowserProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { PurchaseApproval } from "./purchase-gate.js";
import { detectPurchase, purchaseApprovalOf, purchaseCardSummary } from "./purchase-gate.js";
import type { RunContext } from "./run-context.js";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareToolRequest } from "./run-tool-request.js";

const CHECKED = "The button label and total are read from the page. The bot has not checked them.";
const found = {
  steps: [],
  site: "shop.example.test",
  label: "Pay‮ now\n",
  amount: " $5 ",
  amountSource: "button" as const,
};

function contextWith(
  check: BrowserProvider["purchaseCheck"],
  overrides: Record<string, unknown> = {},
) {
  return {
    deps: {},
    run: { spaceId: "s", userId: "u" },
    bot: { id: "b" },
    context: { signal: new AbortController().signal },
    providers: { browser: { purchaseCheck: check } },
    state: { walletHosts: new Set<string>() },
    computer: { pageBrowserAllowed: true, heldForTakeover: false, get: async () => ({ id: "c" }) },
    ...overrides,
  } as unknown as RunContext;
}

describe("purchase detection for the page tools", () => {
  it("asks the browser about a click or Enter on the screen, and about nothing else", async () => {
    const check = vi.fn(async (_computer: unknown, _request: unknown) => ({ purchase: found }));
    const ctx = contextWith(check as never);
    const act = (actions: unknown[]) => detectPurchase(ctx, "computer_act", { actions });
    expect(await act([{ kind: "click", x: 1, y: 2 }])).toMatchObject({ site: "shop.example.test" });
    // Each click goes with its spot on the screen, so only the control under it is judged.
    expect(check).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ desktop: true, enter: false, points: [{ x: 1, y: 2 }] }),
      expect.anything(),
    );
    await act([{ kind: "key", key: "Return" }]);
    expect(check).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ desktop: true, enter: true }),
      expect.anything(),
    );
    await act([{ kind: "type", text: "4242\n" }]);
    expect(check).toHaveBeenCalledTimes(3);
    check.mockClear();
    await act([
      { kind: "move", x: 7, y: 8 },
      { kind: "click", x: 5, y: 6 },
    ]);
    expect(check.mock.calls[0]?.[1]).toMatchObject({
      points: [{ x: 5, y: 6 }],
      unplaced: false,
    });
    check.mockClear();
    await act([{ kind: "type", text: "4242" }, { kind: "key", key: "Tab" }, { kind: "scroll" }]);
    expect(check).not.toHaveBeenCalled();
    check.mockClear();
    check.mockImplementation(async () => ({ purchase: found }));
    await act([{ kind: "type", text: "4242\n" }]);
    expect(check).toHaveBeenCalledOnce();
  });

  it("cannot place a click that follows another step of the batch, or an up that has no pointer", async () => {
    const request = async (actions: unknown[]) => {
      const check = vi.fn(async (_computer: unknown, _request: unknown) => ({ purchase: null }));
      await detectPurchase(contextWith(check as never), "computer_act", { actions });
      return check.mock.calls[0]?.[1];
    };
    const click = { kind: "click", x: 5, y: 6 };
    // The first click is placed; anything after a click, key, typing, wait or scroll is not.
    expect(await request([click])).toMatchObject({ points: [{ x: 5, y: 6 }], unplaced: false });
    for (const before of [
      click,
      { kind: "key", key: "Tab" },
      { kind: "type", text: "4242" },
      { kind: "wait", ms: 100 },
      { kind: "scroll", direction: "down" },
      { kind: "down", x: 1, y: 1 },
    ]) {
      expect(
        await request([before, { kind: "click", x: 9, y: 9 }]),
        JSON.stringify(before),
      ).toMatchObject({
        unplaced: true,
      });
    }
    // Moves only place the pointer; they press nothing and do not disturb the page.
    expect(await request([{ kind: "move", x: 1, y: 2 }, click])).toMatchObject({
      points: [{ x: 5, y: 6 }],
      unplaced: false,
    });
    // An up lands where the pointer is: the last move, not its own x and y; with no pointer it is unplaced.
    expect(
      await request([
        { kind: "move", x: 1, y: 2 },
        { kind: "up", x: 99, y: 99 },
      ]),
    ).toMatchObject({
      points: [{ x: 1, y: 2 }],
      unplaced: false,
    });
    expect(await request([{ kind: "up", x: 99, y: 99 }])).toMatchObject({
      points: [],
      unplaced: true,
    });
    expect(await request([{ kind: "click" }])).toMatchObject({ points: [], unplaced: true });
  });

  it("takes every key that submits, with its modifiers written either way", async () => {
    const check = vi.fn(async (_computer: unknown, _request: unknown) => ({ purchase: found }));
    const ctx = contextWith(check as never);
    const keys = ["Return", "KP_Enter", "enter", "ISO_Enter", "Linefeed", "space", "KP_Space"];
    for (const key of [...keys, ...keys.map((name) => `shift+${name}`), "ctrl+alt+Return"]) {
      check.mockClear();
      await detectPurchase(ctx, "computer_act", { actions: [{ kind: "key", key }] });
      expect(check, key).toHaveBeenCalledOnce();
      expect(check.mock.calls[0]?.[1], key).toMatchObject({ desktop: true, enter: true });
    }
    check.mockClear();
    await detectPurchase(ctx, "computer_act", {
      actions: [{ kind: "key", key: "Return", modifiers: ["shift"] }],
    });
    expect(check).toHaveBeenCalledOnce();
    // The submitting key may be any part of the key, or any modifier.
    for (const step of [
      { key: "a", modifiers: ["Return"] },
      { key: "Return+a" },
      { key: "ctrl+Return+a" },
      { key: "Tab", modifiers: ["shift", "space"] },
    ]) {
      check.mockClear();
      await detectPurchase(ctx, "computer_act", { actions: [{ kind: "key", ...step }] });
      expect(check, JSON.stringify(step)).toHaveBeenCalledOnce();
    }
    check.mockClear();
    for (const key of ["Tab", "Escape", "a", "ctrl+a", "shift+Tab", "ctrl+Home"]) {
      await detectPurchase(ctx, "computer_act", { actions: [{ kind: "key", key }] });
    }
    expect(check).not.toHaveBeenCalled();
  });

  it("presses an approved desktop purchase only while the page still shows what the card did", async () => {
    let now: typeof found | null = found;
    const ctx = contextWith(vi.fn(async () => ({ purchase: now })));
    const replay = async (approval: Record<string, unknown>) =>
      prepareToolRequest(ctx, {
        name: "computer_act",
        nextApprovedTool: "computer_act",
        args: { actions: [{ kind: "click", x: 1, y: 2 }], purchaseApproval: approval },
      } as unknown as ToolRequest);
    const approval = { steps: [], site: "shop.example.test", label: "Pay now", amount: "$5" };
    expect(await replay(approval)).toBeUndefined();
    const changed = { error: expect.stringContaining("nothing was pressed") };
    now = { ...found, amount: "$50" };
    expect(await replay(approval)).toEqual(changed);
    now = null;
    expect(await replay(approval)).toEqual(changed);
    // A card that named nothing, because the check failed, has nothing to compare.
    expect(await replay({ steps: [], site: "", label: "", amount: "" })).toBeUndefined();
  });

  it("shows no card only where this run typed an approved wallet card or token, and still approves the click", async () => {
    const check = vi.fn(async () => ({ purchase: { ...found, steps: [0] } }));
    const ctx = contextWith(check);
    const prepare = async () => {
      const request = {
        name: "browser_act",
        args: { actions: [{ kind: "click", ref: "e1" }] },
      } as unknown as ToolRequest;
      expect(await prepareToolRequest(ctx, request)).toBeUndefined();
      return request;
    };
    expect((await prepare()).purchase).toBeDefined();
    ctx.state.walletHosts.add("other.example.test");
    expect((await prepare()).purchase).toBeDefined();
    ctx.state.walletHosts.add("shop.example.test");
    const exempt = await prepare();
    expect(exempt.purchase).toBeUndefined();
    expect(exempt.fleetSummary).toBeUndefined();
    // The page helper refuses an unapproved purchase click, so the exempt click carries its approval.
    expect(exempt.args.purchaseApproval).toMatchObject({ steps: [0], site: "shop.example.test" });
    // It is spent: a second purchase on that host asks.
    expect((await prepare()).purchase).toBeDefined();
    expect([...ctx.state.walletHosts]).toEqual(["other.example.test"]);
  });

  it("keeps only the page's visible words and bounds them", async () => {
    const purchase = await detectPurchase(
      contextWith(async () => ({ purchase: found })),
      "computer_act",
      { actions: [{ kind: "click", x: 1, y: 2 }] },
    );
    expect(purchase).toEqual({
      steps: [],
      site: "shop.example.test",
      label: "Pay now",
      amount: "$5",
      amountSource: "button",
    });
  });

  it("cuts the page's words by characters, so no half of an emoji is stored", async () => {
    const long = { ...found, label: `${"a".repeat(79)}😀tail`, amount: `${"1".repeat(39)}😀` };
    const purchase = await detectPurchase(
      contextWith(async () => ({ purchase: long })),
      "computer_act",
      { actions: [{ kind: "click", x: 1, y: 2 }] },
    );
    expect(purchase?.label).toBe(`${"a".repeat(79)}😀`);
    expect(Array.from(purchase?.amount ?? "")).toHaveLength(40);
    expect(JSON.stringify(purchase)).not.toMatch(/\\ud[89ab][0-9a-f]{2}"/i);
  });

  it("asks about nothing when there is no way to check", async () => {
    const args = { actions: [{ kind: "click", x: 1, y: 2 }] };
    expect(await detectPurchase(contextWith(undefined), "computer_act", args)).toBeUndefined();
    const check = vi.fn(async () => ({ purchase: found }));
    const held = contextWith(check, {
      computer: { pageBrowserAllowed: true, heldForTakeover: true, get: async () => ({}) },
    });
    expect(await detectPurchase(held, "computer_act", args)).toBeUndefined();
    const off = contextWith(check, { computer: { pageBrowserAllowed: false } });
    expect(await detectPurchase(off, "computer_act", args)).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it("asks about a press after the batch opens a URL, without looking at the page first", async () => {
    const check = vi.fn(async () => ({ purchase: null }));
    const ctx = contextWith(check as never);
    const act = (actions: unknown[]) => detectPurchase(ctx, "computer_act", { actions });
    const unchecked = { steps: [], site: "", label: "", amount: "", amountSource: "page" };
    const open = { kind: "focus", app: "chromium", uri: "https://shop.example.test/checkout" };
    for (const press of [
      { kind: "click", x: 5, y: 6 },
      { kind: "key", key: "Return" },
      { kind: "key", key: "a", modifiers: ["Return"] },
      { kind: "type", text: "go\n" },
    ]) {
      expect(await act([open, press])).toEqual(unchecked);
    }
    expect(check).not.toHaveBeenCalled();
    // A focus that opens nothing, or a URL opened after the press, is checked as usual.
    expect(
      await act([
        { kind: "focus", app: "chromium" },
        { kind: "click", x: 5, y: 6 },
      ]),
    ).toBeUndefined();
    expect(await act([{ kind: "click", x: 5, y: 6 }, open])).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("reads a stored approval only when it is whole", () => {
    const good = {
      steps: [0, 3],
      site: "shop.example.test:8443",
      label: "",
      amount: "",
      amountSource: "page" as const,
    };
    expect(purchaseApprovalOf(good)).toEqual(good);
    expect(purchaseApprovalOf({ ...good, amountSource: undefined })).toEqual(good);
    // A check that failed knows no site.
    expect(purchaseApprovalOf({ ...good, site: "" })).toEqual({ ...good, site: "" });
    expect(purchaseCardSummary({ ...good, site: "" })).toEqual({
      onceOnly: true,
      title: "Complete a payment on this page?",
      lines: ["The page could not be checked, so this may complete a payment."],
    });
    for (const bad of [
      null,
      "x",
      { ...good, steps: [-1] },
      { ...good, steps: [1.5] },
      { ...good, steps: "1" },
      { ...good, site: "bad site" },
      { ...good, label: 1 },
    ]) {
      expect(purchaseApprovalOf(bad)).toBeUndefined();
    }
  });

  it("escapes the site in the card title and leaves out what the page did not show", () => {
    const approval = {
      steps: [],
      site: "a_b*.test",
      label: "",
      amount: "",
      amountSource: "page",
    } satisfies PurchaseApproval;
    // A purchase is approved one click at a time: the card never offers Always allow.
    expect(purchaseCardSummary(approval)).toEqual({
      onceOnly: true,
      title: "Pay on a\\_b\\*.test?",
      lines: [CHECKED],
    });
    const shop = { steps: [], site: "shop.test", label: "Pay $5", amount: "$5" };
    expect(purchaseCardSummary({ ...shop, amountSource: "page" }).lines).toEqual([
      'Button: "Pay $5"',
      "Total on the page: $5",
      CHECKED,
    ]);
    expect(purchaseCardSummary({ ...shop, amountSource: "button" }).lines).toEqual([
      'Button: "Pay $5"',
      "Amount on the button: $5",
      CHECKED,
    ]);
  });
});
