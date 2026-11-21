// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { Me, RakazoDesktop } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueryRoot } from "../../lib/query/query-root.test-support";
import { HostComputerPrompt } from "./host-computer-prompt";

const dialogProps = vi.hoisted(() => ({
  onOpenChange: undefined as ((open: boolean) => void) | undefined,
}));
const rpc = vi.hoisted(() => ({ me: vi.fn() }));

vi.mock("@rakazo/ui-web", () => {
  const Block = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    Dialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => {
      dialogProps.onOpenChange = onOpenChange;
      return open ? <div role="dialog">{children}</div> : null;
    },
    // The close button closes the dialog through onOpenChange, as the real one does.
    DialogContent: ({
      showCloseButton,
      children,
    }: {
      showCloseButton?: boolean;
      children: ReactNode;
    }) => (
      <div>
        {showCloseButton ? (
          <button type="button" onClick={() => dialogProps.onOpenChange?.(false)}>
            Close
          </button>
        ) : null}
        {children}
      </div>
    ),
    DialogDescription: Block,
    DialogHeader: Block,
    DialogTitle: Block,
  };
});
vi.mock("../../lib/query/rpc", () => ({
  rpc,
  rpcForSpace: () => rpc,
  createSpaceRpc: () => rpc,
  selectedSpaceId: () => null,
}));

let configure: (() => void) | undefined;
let host: HTMLDivElement;
let root: ReturnType<typeof createQueryRoot>;

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  rpc.me.mockResolvedValue(docker);
  configure = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createQueryRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.rakazoDesktop;
  dialogProps.onOpenChange = undefined;
  vi.unstubAllGlobals();
});

/** A Mac whose local access the person can change from the App menu. */
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
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <HostComputerPrompt initialMe={docker} />
      </I18nProvider>,
    ),
  );
}

/** App menu → Computer Access…, which reads the current choice first. */
async function openFromMenu() {
  await act(async () => {
    configure?.();
    await flush();
  });
}

/** Escape, an outside click or the close button all reach the dialog through onOpenChange. */
async function dismiss() {
  await act(async () => dialogProps.onOpenChange?.(false));
}

async function click(label: string) {
  await act(async () => {
    button(label)?.click();
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

it("stays open while a local access request is pending, and shows its failure", async () => {
  const request = deferred<boolean>();
  macWith({ requestAccess: vi.fn(() => request.promise) });
  await renderPrompt();
  await openFromMenu();

  await click("Use this Mac");
  await dismiss();

  expect(dialogIsOpen()).toBe(true);
  expect(button("Close")).toBeUndefined();
  expect(button("Docker")?.disabled).toBe(true);

  await act(async () => {
    request.reject(new Error("Local computer access was refused"));
    await flush();
  });
  await vi.waitFor(() => expect(alertText()).toBe("Local computer access was refused"));
  expect(dialogIsOpen()).toBe(true);

  // Once nothing is running, the close button works again.
  await click("Close");
  expect(dialogIsOpen()).toBe(false);
});

it("stays open while a revoke is pending, and closes once it is saved", async () => {
  const revoke = deferred<void>();
  macWith({ revokeAccess: vi.fn(() => revoke.promise) });
  await renderPrompt();
  await openFromMenu();

  await click("Docker");
  await dismiss();
  expect(dialogIsOpen()).toBe(true);

  await act(async () => {
    revoke.resolve();
    await flush();
  });
  await vi.waitFor(() => expect(dialogIsOpen()).toBe(false));
});

it("stays open while Check again runs, and shows its failure", async () => {
  const check = deferred<Me>();
  macWith({
    requestAccess: vi.fn(async () => {
      throw new Error("Local computer access was refused");
    }),
  });
  await renderPrompt();
  await openFromMenu();
  await click("Use this Mac");
  await vi.waitFor(() => expect(alertText()).toBe("Local computer access was refused"));

  rpc.me.mockReturnValueOnce(check.promise);
  await click("Check again");
  await dismiss();
  expect(dialogIsOpen()).toBe(true);
  expect(button("Docker")?.disabled).toBe(true);

  await act(async () => {
    check.reject(new Error("Computer check failed"));
    await flush();
  });
  await vi.waitFor(() => expect(alertText()).toBe("Computer check failed"));
  expect(dialogIsOpen()).toBe(true);
});
