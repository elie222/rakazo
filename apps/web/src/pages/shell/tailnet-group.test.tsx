// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const tailnet = vi.hoisted(() => ({
  status: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  setBotAccess: vi.fn(),
}));
const api = vi.hoisted(() => ({ tailnet }));
vi.mock("../../lib/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => `${text}${index > 0 ? String(values[index - 1]) : ""}${part}`,
      "",
    );
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});

import { TailnetGroup } from "./tailnet-group";

const disconnected = { unavailable: null, connection: null };
const connected = (botIds: string[]) => ({
  unavailable: null,
  connection: { tag: "tag:rakazo", botIds },
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.resetAllMocks();
});

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TailnetGroup botId="helper" />
      </QueryClientProvider>,
    ),
  );
  await act(async () => vi.waitFor(() => expect(tailnet.status).toHaveBeenCalled()));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function button(label: string) {
  const match = [...document.querySelectorAll("button")].filter(
    (item) => item.textContent === label,
  );
  const last = match.at(-1);
  if (!last) throw new Error(`Missing ${label}`);
  return last;
}

function type(label: string, value: string) {
  const field = [...document.querySelectorAll("label")].find((item) => item.textContent === label);
  const input = document.getElementById(field?.htmlFor ?? "") as HTMLInputElement | null;
  if (!input) throw new Error(`Missing ${label}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("shows nothing on a server that can't put bots on a tailnet", async () => {
  tailnet.status.mockResolvedValue({ unavailable: "unsupported", connection: null });
  await render();
  expect(container.textContent).toBe("");
});

it("connects a tailnet with an OAuth client, then turns this bot on", async () => {
  tailnet.status.mockResolvedValue(disconnected);
  tailnet.connect.mockResolvedValue(connected([]));
  tailnet.setBotAccess.mockResolvedValue(connected(["helper"]));
  await render();

  await act(async () => button("Connect tailnet").click());
  await act(async () => {
    type("OAuth client ID", "client-a");
    type("OAuth client secret", "tskey-client-kTEST-secretvalue");
  });
  await act(async () => button("Connect").click());
  expect(tailnet.connect).toHaveBeenCalledWith({
    clientId: "client-a",
    clientSecret: "tskey-client-kTEST-secretvalue",
  });

  const access = await act(async () =>
    vi.waitFor(() => {
      const found = container.querySelector('[role="switch"]');
      if (!found) throw new Error("no switch yet");
      return found as HTMLElement;
    }),
  );
  expect(access.getAttribute("aria-checked")).toBe("false");
  await act(async () => access.click());
  expect(tailnet.setBotAccess).toHaveBeenCalledWith({ botId: "helper", enabled: true });
  await act(async () => vi.waitFor(() => expect(access.getAttribute("aria-checked")).toBe("true")));
});

it("shows why the tailnet refused the client", async () => {
  tailnet.status.mockResolvedValue(disconnected);
  tailnet.connect.mockRejectedValue(new Error("Tailscale did not accept this OAuth client."));
  await render();
  await act(async () => button("Connect tailnet").click());
  await act(async () => {
    type("OAuth client ID", "client-a");
    type("OAuth client secret", "wrong");
  });
  await act(async () => button("Connect").click());
  await act(async () =>
    vi.waitFor(() =>
      expect(document.body.textContent).toContain("Tailscale did not accept this OAuth client."),
    ),
  );
});

it("disconnects after confirming", async () => {
  tailnet.status.mockResolvedValue(connected(["helper"]));
  tailnet.disconnect.mockResolvedValue(disconnected);
  await render();
  await act(async () => button("Disconnect tailnet").click());
  expect(tailnet.disconnect).not.toHaveBeenCalled();
  await act(async () => button("Disconnect").click());
  expect(tailnet.disconnect).toHaveBeenCalledTimes(1);
  await act(async () => vi.waitFor(() => expect(button("Connect tailnet")).toBeTruthy()));
});
