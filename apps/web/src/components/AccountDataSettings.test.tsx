// @vitest-environment jsdom

import { createHash, webcrypto } from "node:crypto";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const accountToken = vi.hoisted(() => vi.fn());

// The dialog itself is tested on its own; here it is a button that confirms it.
vi.mock("./ConfirmIdentityDialog", async () => {
  const { useState } = await import("react");
  const { runWithIdentityConfirmation } = await import("@rakazo/contracts");
  return {
    useIdentityConfirmation: () => {
      const [settle, setSettle] = useState<((confirmed: boolean) => void) | null>(null);
      return {
        withIdentityConfirmation: <T,>(action: () => Promise<T>) =>
          runWithIdentityConfirmation(
            action,
            () => new Promise<boolean>((resolve) => setSettle(() => resolve)),
          ),
        identityDialog: settle ? (
          <button
            type="button"
            data-testid="identity-confirm"
            onClick={() => {
              settle(true);
              setSettle(null);
            }}
          />
        ) : null,
      };
    },
  };
});
vi.mock("../lib/rpc", () => ({
  rpc: { export: { accountToken } },
  recheckSessionOnUnauthorized: () => undefined,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((acc, part, i) => acc + part + (values[i] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button type="button" {...props} />
  ),
  Spinner: () => null,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor arrives via props.
  Label: ({ children, ...props }: ComponentProps<"label">) => <label {...props}>{children}</label>,
}));
vi.mock("./ai/primitives", () => ({
  SuccessPop: ({ label }: { label: string }) => <span data-testid="success">{label}</span>,
}));

import { AccountDataSettings } from "./AccountDataSettings";

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("crypto", webcrypto);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  accountToken.mockReset();
});

async function render(onImported?: () => Promise<void>) {
  await act(async () => {
    root.render(<AccountDataSettings onImported={onImported} />);
  });
}

function button(name: string) {
  const match = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === name,
  );
  if (!match) throw new Error(`No ${name} button`);
  return match;
}

async function chooseFile(file: File) {
  const input = container.querySelector<HTMLInputElement>('[data-testid="account-import-file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("confirms identity before minting the export token, then downloads it by link", async () => {
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  accountToken
    .mockRejectedValueOnce(
      Object.assign(new Error("Confirm it's you"), { code: "IDENTITY_CONFIRMATION_REQUIRED" }),
    )
    .mockResolvedValueOnce({ token: "tok/en+1" });
  await render();

  await act(async () => button("Export").click());
  expect(clicked).toHaveLength(0);
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="identity-confirm"]')!.click();
  });

  expect(accountToken).toHaveBeenCalledTimes(2);
  expect(clicked).toHaveLength(1);
  const link = new URL(clicked[0]!.href);
  expect(link.pathname).toBe("/api/account/export");
  expect(link.searchParams.get("token")).toBe("tok/en+1");
  expect(clicked[0]!.hasAttribute("download")).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});

/** Lets the export/import promise chain settle after a click. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function passwordInput(testId: string) {
  return container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
}

async function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function setBackupPassword(password: string, confirm = password) {
  await setInputValue(passwordInput("backup-password"), password);
  await setInputValue(passwordInput("backup-password-confirm"), confirm);
}

/** A breach-range reply that does not contain the password's suffix. */
function cleanRange() {
  return new Response("00AABBCC:2\n", { status: 200 });
}

function breachedRange(password: string) {
  const hash = createHash("sha1").update(password).digest("hex").toUpperCase();
  return new Response(`${hash.slice(5)}:7\n`, { status: 200 });
}

it("uploads the chosen archive and refreshes spaces", async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ spaces: [{ id: "space_1", name: "Imported" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const onImported = vi.fn(async () => undefined);
  await render(onImported);
  const file = new File(["zip"], "rakazo-export.zip", { type: "application/zip" });

  await chooseFile(file);

  expect(fetchMock).toHaveBeenCalledWith("/api/account/import", {
    method: "POST",
    headers: { "content-type": "application/zip" },
    credentials: "include",
    body: file,
  });
  expect(onImported).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-testid="success"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("shows the server's message when the import is rejected", async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ error: "This archive is from a newer version." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  );
  const onImported = vi.fn(async () => undefined);
  await render(onImported);

  await chooseFile(new File(["zip"], "rakazo-export.zip"));

  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "This archive is from a newer version.",
  );
  expect(onImported).not.toHaveBeenCalled();
  expect(button("Import").disabled).toBe(false);
});

it("exports with a backup password over POST and downloads the blob", async () => {
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake-url");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  fetchMock.mockResolvedValueOnce(cleanRange()).mockResolvedValueOnce(
    new Response(new Blob(["zip"], { type: "application/zip" }), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="rakazo-export-2026-11-10.zip"',
      },
    }),
  );
  accountToken.mockResolvedValueOnce({ token: "tok/1" });
  await render();
  await setBackupPassword("correct horse battery staple");

  await act(async () => button("Export").click());
  await flush();

  expect(accountToken).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const post = fetchMock.mock.calls[1]!;
  expect(post[0]).toBe("/api/account/export");
  expect(post[1]).toMatchObject({
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
  });
  expect(JSON.parse(String(post[1]?.body))).toEqual({
    token: "tok/1",
    backupPassword: "correct horse battery staple",
  });
  expect(clicked).toHaveLength(1);
  expect(clicked[0]!.href).toBe("blob:fake-url");
  expect(clicked[0]!.getAttribute("download")).toBe("rakazo-export-2026-11-10.zip");
  expect(passwordInput("backup-password").value).toBe("");
});

it("refuses a backup password shorter than 12 characters", async () => {
  accountToken.mockResolvedValue({ token: "tok/1" });
  await render();
  await setBackupPassword("too short");

  await act(async () => button("Export").click());

  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Use at least 12 characters for the backup password",
  );
  expect(accountToken).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("refuses a mismatched backup password confirmation", async () => {
  accountToken.mockResolvedValue({ token: "tok/1" });
  await render();
  await setBackupPassword("correct horse battery staple", "a different password");

  await act(async () => button("Export").click());

  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Backup passwords do not match",
  );
  expect(accountToken).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("refuses a breached backup password", async () => {
  const password = "correct horse battery staple";
  fetchMock.mockResolvedValueOnce(breachedRange(password));
  accountToken.mockResolvedValue({ token: "tok/1" });
  await render();
  await setBackupPassword(password);

  await act(async () => button("Export").click());
  await flush();

  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "This password appeared in a data breach. Choose another.",
  );
  expect(accountToken).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("sends the backup password when importing", async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ spaces: [{ id: "space_1", name: "Imported" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const onImported = vi.fn(async () => undefined);
  await render(onImported);
  await setBackupPassword("correct horse battery staple");

  await chooseFile(new File(["zip"], "rakazo-export.zip"));

  expect(fetchMock).toHaveBeenCalledWith("/api/account/import", {
    method: "POST",
    headers: {
      "content-type": "application/zip",
      "x-rakazo-backup-password": "correct horse battery staple",
    },
    credentials: "include",
    body: expect.any(File),
  });
  expect(onImported).toHaveBeenCalledTimes(1);
  expect(passwordInput("backup-password").value).toBe("");
});

it("shows a credential warning without failing the import", async () => {
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        spaces: [{ id: "space_1", name: "Imported" }],
        credentials: { error: "Wrong backup password: provider keys were skipped." },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  const onImported = vi.fn(async () => undefined);
  await render(onImported);

  await chooseFile(new File(["zip"], "rakazo-export.zip"));

  expect(onImported).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-testid="success"]')).not.toBeNull();
  expect(container.textContent).toContain("Wrong backup password: provider keys were skipped.");
});
