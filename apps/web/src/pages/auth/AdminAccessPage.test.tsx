// @vitest-environment jsdom
import type { AccessGrant } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/query/rpc", () => {
  const rpc = { accessGrants: { create: api.create, revoke: api.revoke } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../../lib/query/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    me: { queryOptions: () => ({ queryKey: ["me"], queryFn: async () => ({ isAdmin: true }) }) },
    accessGrants: {
      list: {
        key: () => ["grants"],
        queryOptions: () => ({ queryKey: ["grants"], queryFn: () => api.list() }),
      },
    },
  }),
}));
vi.mock("../../lib/query/user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../../components/WindowChrome", () => ({ WindowChrome: () => null }));
vi.mock("../../components/PageLoading", () => ({ PageLoading: () => null }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value }: { value: number }) => value,
}));
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Badge: Pass,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" {...props} />
    ),
    buttonVariants: () => "",
    Field: Pass,
    FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Spinner: () => <span role="status" />,
    toast: { error: api.toastError },
  };
});

import type * as Query from "../../lib/query/query";
import { AdminAccessPage } from "./AdminAccessPage";

const pending: AccessGrant = {
  id: "grant-1",
  email: "friend@example.test",
  creditCents: 500,
  freeMonths: 0,
  createdBy: null,
  status: "pending",
  createdAt: "2026-10-01T00:00:00.000Z",
  appliedAt: null,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockReset().mockResolvedValue([pending]);
  api.create.mockReset();
  api.revoke.mockReset();
  api.toastError.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <AdminAccessPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="access-grants"]')).toBeTruthy(),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(name: string) {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}

async function type(id: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!field) throw new Error(`Missing field ${id}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return field;
}

async function fillGrant() {
  const email = await type("grant-email", "new@example.test");
  await type("grant-credits", "5");
  return email;
}

it("grants once, holds every control meanwhile, then lists the grant and clears the form", async () => {
  const granting = deferred<AccessGrant>();
  api.create.mockReturnValue(granting.promise);
  const email = await fillGrant();
  await act(async () => {
    email.form?.requestSubmit();
    email.form?.requestSubmit();
  });
  expect(api.create.mock.calls).toEqual([
    [{ email: "new@example.test", creditCents: 500, freeMonths: 0 }],
  ]);
  expect(button("Granting…").disabled).toBe(true);
  expect(button("Revoke").disabled).toBe(true);

  const added = { ...pending, id: "grant-2", email: "new@example.test" };
  api.list.mockResolvedValue([pending, added]);
  await act(async () => granting.resolve(added));
  await vi.waitFor(() => expect(container.textContent).toContain("new@example.test"));
  expect(api.list).toHaveBeenCalledTimes(2);
  expect(email.value).toBe("");
  expect(button("Revoke").disabled).toBe(false);
});

it("says why a grant failed, keeps what was typed and offers the controls again", async () => {
  api.create.mockRejectedValue("refused");
  const email = await fillGrant();
  await act(async () => email.form?.requestSubmit());
  expect(api.toastError).toHaveBeenCalledWith("Could not grant access");
  expect(email.value).toBe("new@example.test");
  expect(button("Grant").disabled).toBe(false);
  expect(button("Revoke").disabled).toBe(false);
  expect(api.list).toHaveBeenCalledTimes(1);
});

it("revokes a grant and reads the list again", async () => {
  api.revoke.mockResolvedValue({ ...pending, status: "revoked" });
  api.list.mockResolvedValue([{ ...pending, status: "revoked" }]);
  await act(async () => button("Revoke").click());
  await vi.waitFor(() => expect(container.textContent).toContain("Revoked"));
  expect(api.revoke.mock.calls).toEqual([[{ id: "grant-1" }]]);
  expect(api.list).toHaveBeenCalledTimes(2);
});

it("says why a revoke failed", async () => {
  api.revoke.mockRejectedValue("refused");
  await act(async () => button("Revoke").click());
  expect(api.toastError).toHaveBeenCalledWith("Could not revoke grant");
  expect(button("Revoke").disabled).toBe(false);
});
