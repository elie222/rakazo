// @vitest-environment jsdom
import type { ComputerUpdate } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { computerUpdates } from "../../lib/computers/computer-updates";
import { createQueryRoot as createRoot } from "../../lib/query/query-root.test-support";
import { ComputerUpdateProgress } from "./ComputerUpdateProgress";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) =>
    open ? (
      <div
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") onOpenChange(false);
        }}
      >
        {children}
      </div>
    ) : null,
  DialogContent: ({ children, ...props }: ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Spinner: () => <span />,
  cn: (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" "),
}));
const computer = vi.hoisted(() => ({
  updates: vi.fn(),
  recover: vi.fn(),
  dismissUpdate: vi.fn(),
}));
vi.mock("../../lib/query/rpc", () => {
  const rpc = { computer };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => null,
    SPACE_SELECTED_EVENT: "space-selected",
  };
});

const failed = {
  id: "update-failed",
  botId: "bot-ada",
  name: "Ada",
  mode: "dedicated",
  action: "recover",
  status: "failed",
  stage: "restoring",
} as ComputerUpdate;
const healthy = {
  id: "update-healthy",
  botId: "bot-ben",
  name: "Ben",
  mode: "dedicated",
  action: "recover",
  status: "running",
  stage: "preparing",
} as ComputerUpdate;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  computer.updates.mockResolvedValue([failed]);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

const render = () => act(() => root.render(<ComputerUpdateProgress onCompleted={() => {}} />));
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
const click = (label: string) => act(async () => button(label)?.click());
const dialog = () => host.querySelector<HTMLElement>('[data-testid="computer-update-dialog"]');
const failureShown = (message = "refused") =>
  [...host.querySelectorAll('[role="alert"]')].some((item) => item.textContent === message);
const closeDialog = () =>
  act(async () =>
    dialog()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );

/** Opens the failed update the way a user does, from its progress pill. */
const openFailed = async () => {
  await render();
  await vi.waitFor(() => expect(button("Recovery failed")).toBeDefined());
  await click("Recovery failed");
};

it("shows the failed recovery's error after its Recover press is refused", async () => {
  computer.recover.mockRejectedValueOnce(new Error("refused"));
  await openFailed();
  await click("Recover computer");
  expect(failureShown()).toBe(true);
});

it("starts a recovery opened from bot settings without the earlier failure's error", async () => {
  computer.recover.mockRejectedValueOnce(new Error("refused"));
  await openFailed();
  await click("Recover computer");
  expect(failureShown()).toBe(true);

  await closeDialog();
  expect(dialog()).toBeNull();

  computer.recover.mockResolvedValueOnce(healthy);
  await act(() => computerUpdates.start("bot-ben", "recover"));
  expect(dialog()?.textContent).toContain("Ben");
  expect(failureShown()).toBe(false);
});

it("does not show a failed dismiss on a different update opened after it", async () => {
  const dismissed = deferred<void>();
  computer.dismissUpdate.mockReturnValueOnce(dismissed.promise);
  await openFailed();
  await click("Dismiss");
  await closeDialog();

  computer.recover.mockResolvedValueOnce(healthy);
  await act(() => computerUpdates.start("bot-ben", "recover"));
  await act(async () => dismissed.reject(new Error("refused")));
  expect(dialog()?.textContent).toContain("Ben");
  expect(failureShown()).toBe(false);
});

it("opens a failed update again without its earlier error", async () => {
  computer.recover.mockRejectedValueOnce(new Error("refused"));
  await openFailed();
  await click("Recover computer");
  expect(failureShown()).toBe(true);

  await closeDialog();
  await click("Recovery failed");
  expect(dialog()).not.toBeNull();
  expect(failureShown()).toBe(false);
});

it("shows why a Dismiss was refused, and plain copy for a technical failure", async () => {
  await openFailed();
  computer.dismissUpdate.mockRejectedValueOnce(new Error("Someone else is using this computer"));
  await click("Dismiss");
  expect(failureShown("Someone else is using this computer")).toBe(true);

  computer.dismissUpdate.mockRejectedValueOnce(new Error("TypeError: cannot read properties"));
  await click("Dismiss");
  expect(failureShown("Could not complete action")).toBe(true);
  expect(dialog()?.querySelectorAll('[role="alert"]')).toHaveLength(1);
});
