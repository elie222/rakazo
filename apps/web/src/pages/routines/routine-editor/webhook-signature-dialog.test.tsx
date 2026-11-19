// @vitest-environment jsdom

import type { WebhookSignature } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/ui-web", () => {
  const passthrough =
    (Tag: "div" | "label" | "p") =>
    ({ children, ...props }: { children?: ReactNode }) => <Tag {...props}>{children}</Tag>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogContent: passthrough("div"),
    DialogFooter: passthrough("div"),
    DialogHeader: passthrough("div"),
    DialogTitle: passthrough("div"),
    Field: passthrough("div"),
    FieldError: ({ children }: { children?: ReactNode }) =>
      children ? <p role="alert">{children}</p> : null,
    FieldLabel: passthrough("label"),
    Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    OptionSelect: ({
      options,
      onValueChange,
      ...props
    }: {
      id?: string;
      value: string;
      "aria-label"?: string;
      options: { value: string; label: string }[];
      onValueChange: (value: string) => void;
    }) => (
      <select {...props} onChange={(event) => onValueChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

import { WebhookSignatureDialog } from "./webhook-signature-dialog";

let root: ReturnType<typeof createRoot> | undefined;

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

async function render(props: Partial<ComponentProps<typeof WebhookSignatureDialog>> = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const all = {
    open: true,
    onOpenChange: vi.fn(),
    signature: null,
    onSave: vi.fn(async () => undefined),
    onClear: vi.fn(async () => undefined),
    ...props,
  };
  await act(async () => root?.render(<WebhookSignatureDialog {...all} />));
  return { container, ...all };
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

function field(container: HTMLElement, label: string) {
  const labelled = [...container.querySelectorAll("label")].find((l) => l.textContent === label);
  const id = labelled?.getAttribute("for");
  return (
    id
      ? container.querySelector(`[id="${id}"]`)
      : container.querySelector(`[aria-label="${label}"]`)
  ) as HTMLInputElement | HTMLSelectElement;
}

const submit = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === "Save")!;

it("saves a body HMAC with its header, algorithm, encoding and prefix", async () => {
  const { container, onSave, onOpenChange } = await render();
  await act(async () => setValue(field(container, "Format"), "hmac"));
  expect(submit(container).disabled).toBe(true);

  await act(async () => {
    setValue(field(container, "Signature header"), " X-Signature ");
    setValue(field(container, "Algorithm"), "sha512");
    setValue(field(container, "Encoding"), "base64");
    setValue(field(container, "Prefix"), "sha512=");
    setValue(field(container, "Secret"), " fake-sender-secret ");
  });
  expect(field(container, "Secret").getAttribute("type")).toBe("password");
  await act(async () => submit(container).click());

  expect(onSave).toHaveBeenCalledExactlyOnceWith(
    {
      scheme: "hmac",
      header: "X-Signature",
      algorithm: "sha512",
      encoding: "base64",
      prefix: "sha512=",
    },
    "fake-sender-secret",
  );
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("needs both headers for a v0 signature", async () => {
  const { container, onSave } = await render();
  await act(async () => {
    setValue(field(container, "Format"), "timestamp-v0");
    setValue(field(container, "Signature header"), "x-request-signature");
    setValue(field(container, "Secret"), "fake-sender-secret");
  });
  expect(submit(container).disabled).toBe(true);
  await act(async () => setValue(field(container, "Timestamp header"), "x-request-timestamp"));
  await act(async () => submit(container).click());
  expect(onSave).toHaveBeenCalledWith(
    {
      scheme: "timestamp-v0",
      header: "x-request-signature",
      timestampHeader: "x-request-timestamp",
    },
    "fake-sender-secret",
  );
});

it("starts from the saved format, never shows the saved secret, and can remove it", async () => {
  const signature: WebhookSignature = { scheme: "timestamp-v1", header: "x-event-signature" };
  const { container, onClear } = await render({ signature });
  expect((field(container, "Format") as HTMLSelectElement).value).toBe("timestamp-v1");
  expect((field(container, "Signature header") as HTMLInputElement).value).toBe(
    "x-event-signature",
  );
  expect((field(container, "Secret") as HTMLInputElement).value).toBe("");
  const remove = [...container.querySelectorAll("button")].find((b) => b.textContent === "Remove");
  await act(async () => remove?.click());
  expect(onClear).toHaveBeenCalledOnce();
});

it("keeps the dialog open with the reason when saving fails", async () => {
  const onSave = vi.fn(async () => {
    throw new Error("Only the bot's creator can set its webhook key.");
  });
  const { container, onOpenChange } = await render({ onSave });
  await act(async () => setValue(field(container, "Secret"), "whsec_fake"));
  await act(async () => submit(container).click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Only the bot's creator can set its webhook key.",
  );
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

it("starts again from the saved format each time it opens", async () => {
  const saved: WebhookSignature = { scheme: "timestamp-v1", header: "x-event-signature" };
  const { container, ...props } = await render({ signature: saved });
  await act(async () => {
    setValue(field(container, "Signature header"), "x-abandoned");
    setValue(field(container, "Secret"), "fake-abandoned-secret");
  });
  await act(async () => root?.render(<WebhookSignatureDialog {...props} open={false} />));
  // The card now shows another bot, whose saved format differs.
  const other: WebhookSignature = { scheme: "standard-webhooks" };
  await act(async () => root?.render(<WebhookSignatureDialog {...props} open signature={other} />));
  expect((field(container, "Format") as HTMLSelectElement).value).toBe("standard-webhooks");
  expect((field(container, "Secret") as HTMLInputElement).value).toBe("");
  await act(async () => root?.render(<WebhookSignatureDialog {...props} open={false} />));
  await act(async () => root?.render(<WebhookSignatureDialog {...props} open signature={saved} />));
  expect((field(container, "Signature header") as HTMLInputElement).value).toBe(
    "x-event-signature",
  );
});
