// @vitest-environment jsdom
import type { Me, RakazoDesktop } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueryRoot } from "../../lib/query/query-root.test-support";
import { rpc } from "../../lib/query/rpc";
import { HostComputerPrompt } from "./host-computer-prompt";

const dialog = vi.hoisted(() => ({
  onOpenChange: undefined as ((open: boolean) => void) | undefined,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Block = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Dialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => {
      dialog.onOpenChange = onOpenChange;
      return open ? <div role="dialog">{children}</div> : null;
    },
    DialogContent: Block,
    DialogDescription: Block,
    DialogHeader: Block,
    DialogTitle: Block,
  };
});
vi.mock("../../lib/query/rpc", () => {
  const rpc = { me: vi.fn() };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});

let configure: (() => void) | undefined;
let host: HTMLDivElement;
let root: ReturnType<typeof createQueryRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  configure = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createQueryRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.rakazoDesktop;
  dialog.onOpenChange = undefined;
  vi.unstubAllGlobals();
});

/** A Mac with local access the person can change from the App menu. */
function macWith(computer: Record<string, unknown>) {
  window.rakazoDesktop = {
    platform: "darwin",
    computer: {
      managesHostChoice: true,
      onConfigure: (listener: () => void) => {
        configure = listener;
        return () => undefined;
      },
      ...computer,
    },
  } as unknown as RakazoDesktop;
}

const docker = { canChooseHostComputer: true, computerHost: "docker" } as Me;

async function renderPrompt() {
  await act(async () => root.render(<HostComputerPrompt initialMe={docker} />));
}

/** App menu → Computer Access…, which asks the server for the current choice first. */
async function openFromMenu() {
  await act(async () => {
    configure?.();
    await flush();
  });
}

function dialogIsOpen() {
  return host.querySelector('[role="dialog"]') !== null;
}

function alertText() {
  return host.querySelector('[role="alert"]')?.textContent ?? null;
}

function button(label: string) {
  return [...host.querySelectorAll("button")].find((node) => node.textContent === label);
}

async function click(label: string) {
  await act(async () => {
    button(label)?.click();
    await flush();
  });
}

it("opens each time without the failure from the last attempt", async () => {
  macWith({
    revokeAccess: vi.fn(async () => {
      throw new Error("Computer access was refused");
    }),
  });
  vi.mocked(rpc.me).mockResolvedValue(docker);
  await renderPrompt();
  await openFromMenu();
  expect(dialogIsOpen()).toBe(true);

  await click("Docker");
  expect(alertText()).toBe("Computer access was refused");
  expect(button("Check again")).toBeDefined();

  await act(async () => dialog.onOpenChange?.(false));
  expect(dialogIsOpen()).toBe(false);

  await openFromMenu();
  expect(dialogIsOpen()).toBe(true);
  expect(alertText()).toBeNull();
  expect(button("Check again")).toBeUndefined();
});

it("stays open while a choice or a check is still running", async () => {
  const save = deferred<void>();
  const check = deferred<Me>();
  macWith({ revokeAccess: vi.fn(() => save.promise) });
  vi.mocked(rpc.me).mockResolvedValueOnce(docker).mockReturnValueOnce(check.promise);
  await renderPrompt();
  await openFromMenu();
  await click("Docker");
  await act(async () => dialog.onOpenChange?.(false));
  expect(dialogIsOpen()).toBe(true);

  await act(async () => {
    save.reject(new Error("Computer access was refused"));
    await flush();
  });
  await click("Check again");
  await act(async () => dialog.onOpenChange?.(false));
  expect(dialogIsOpen()).toBe(true);

  await act(async () => {
    check.reject(new Error("Still refused"));
    await flush();
  });
  await act(async () => dialog.onOpenChange?.(false));
  expect(dialogIsOpen()).toBe(false);
});

it("opens without a failed check from the last attempt", async () => {
  macWith({
    revokeAccess: vi.fn(async () => {
      throw new Error("Computer access was refused");
    }),
  });
  vi.mocked(rpc.me).mockResolvedValueOnce(docker).mockRejectedValueOnce(new Error("Still refused"));
  await renderPrompt();
  await openFromMenu();
  await click("Docker");
  await click("Check again");
  expect(alertText()).toBe("Still refused");

  await act(async () => dialog.onOpenChange?.(false));
  await openFromMenu();
  expect(dialogIsOpen()).toBe(true);
  expect(alertText()).toBeNull();
  expect(button("Check again")).toBeUndefined();
});
