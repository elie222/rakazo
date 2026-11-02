// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerProviderSettings } from "./ComputerProviderSettings";

vi.mock("@lingui/react/macro", () => {
  // Stable like Lingui's own, since the form reloads when it changes.
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ size: _size, ...props }: ComponentProps<"button"> & { size?: string }) => (
    <button {...props} />
  ),
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));
vi.mock("./ai/primitives", () => ({ SuccessPop: () => null }));
const { deployment, account } = vi.hoisted(() => ({
  deployment: { get: vi.fn(), update: vi.fn() },
  account: { get: vi.fn(), update: vi.fn() },
}));
// Like the real client, every property read returns a new object.
vi.mock("../lib/rpc", () => ({
  rpc: {
    get computerProvider() {
      return {
        ...deployment,
        get account() {
          return { ...account };
        },
      };
    },
  },
}));

const saved = {
  provider: "wuying" as const,
  defaultProvider: "wuying",
  wuying: {
    regionId: "cn-hangzhou",
    desktopId: "ecd-own",
    endUserId: "end-user",
    mcpUrl: "https://gateway.example.com/mcp",
    hasAccessKey: true,
    hasMcpToken: true,
  },
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("saves an account's own desktop to the account, never the deployment", async () => {
  account.get.mockResolvedValue(saved);
  account.update.mockResolvedValue(saved);
  const onProviderChange = vi.fn();
  await act(async () =>
    root.render(<ComputerProviderSettings scope="account" onProviderChange={onProviderChange} />),
  );
  expect(host.querySelector<HTMLInputElement>("input")?.value).toBe("ecd-own");
  // Loaded once, not again on every render.
  expect(account.get).toHaveBeenCalledOnce();

  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(account.update).toHaveBeenCalledWith({
    provider: "wuying",
    wuying: expect.objectContaining({ desktopId: "ecd-own", accessKeySecret: "", mcpToken: "" }),
  });
  expect(deployment.get).not.toHaveBeenCalled();
  expect(deployment.update).not.toHaveBeenCalled();
  expect(onProviderChange).toHaveBeenCalledWith("wuying");
});

it("reports the deployment default once an account goes back to it", async () => {
  account.get.mockResolvedValue({ provider: "default", defaultProvider: "docker", wuying: null });
  account.update.mockResolvedValue({
    provider: "default",
    defaultProvider: "docker",
    wuying: null,
  });
  const onProviderChange = vi.fn();
  await act(async () =>
    root.render(<ComputerProviderSettings scope="account" onProviderChange={onProviderChange} />),
  );
  expect(host.querySelector("input")).toBeNull();
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(account.update).toHaveBeenCalledWith({ provider: "default" });
  expect(onProviderChange).toHaveBeenCalledWith("docker");
});

/** Types into the field labelled `label` the way a person pasting would. */
function paste(label: string, text: string) {
  const id = [...host.querySelectorAll("label")].find(
    (node) => node.textContent === label,
  )?.htmlFor;
  const input = host.querySelector<HTMLInputElement>(`[id="${id}"]`);
  if (!input) throw new Error(`no ${label} field`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("fills in the gateway and its token from a pasted MCP config", async () => {
  account.get.mockResolvedValue(saved);
  account.update.mockResolvedValue(saved);
  await act(async () => root.render(<ComputerProviderSettings scope="account" />));
  const config = {
    mcpServers: {
      desktop: {
        url: "https://gateway.example.com:8019/mcp",
        headers: { Authorization: "Bearer test-token" },
      },
    },
  };
  await act(async () => paste("MCP gateway URL", JSON.stringify(config, null, 2)));
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(account.update).toHaveBeenCalledWith({
    provider: "wuying",
    wuying: expect.objectContaining({
      mcpUrl: "https://gateway.example.com:8019/mcp",
      mcpToken: "test-token",
    }),
  });
});
