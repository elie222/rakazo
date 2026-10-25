// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FieldLabel: (props: ComponentProps<"label">) => (
    <label htmlFor={props.htmlFor}>{props.children}</label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

import { RembricSettingsForm } from "./RembricSettingsForm";
import { memoryProviderSettings } from "./registry";

it("validates endpoints, keeps rejected credentials, and clears accepted tokens", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onConnect = vi.fn().mockResolvedValue(false);
  async function fill(type: string, value: string) {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>(`input[type="${type}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  try {
    await act(async () => root.render(<RembricSettingsForm busy={false} onConnect={onConnect} />));
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(true);
    await fill("password", " fake-token ");
    for (const endpoint of [
      "file:///mcp/project-slug",
      "https://user:secret@example.com/mcp/project-slug",
      "https://example.com/mcp/project-slug?token=secret",
      "https://example.com/mcp/Bad_slug",
      "https://example.com/mcp",
    ]) {
      await fill("url", endpoint);
      expect(button.disabled).toBe(true);
    }
    for (const endpoint of [
      "https://example.com/mcp/project-slug",
      "http://127.0.0.1:8000/mcp/project-slug",
    ]) {
      await fill("url", endpoint);
      expect(button.disabled).toBe(false);
    }
    await act(async () => button.click());
    expect(onConnect).toHaveBeenCalledWith({
      settings: { endpoint: "http://127.0.0.1:8000/mcp/project-slug" },
      credentials: { token: "fake-token" },
    });
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(
      " fake-token ",
    );
    onConnect.mockResolvedValue(true);
    await act(async () => button.click());
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("omits URL credentials, query and fragment from connected labels", () => {
  const registration = memoryProviderSettings("rembric")!;
  expect(
    registration.connectedLabel({
      provider: "rembric",
      defaultMemoryScope: "shared",
      updatedAt: "2026-01-01T00:00:00.000Z",
      settings: {
        endpoint: "https://user:secret@example.com/mcp/project-slug?token=secret#secret",
      },
    }),
  ).toBe("https://example.com/mcp/project-slug");
});
