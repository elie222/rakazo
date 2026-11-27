// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { Routine } from "@rakazo/contracts";
import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueryRoot as createRoot } from "../../lib/query/query-root.test-support";
import type { RoutineDraftState } from "../../lib/routines/routine-draft";
import { draftStateFromRoutine, emptyRoutineDraftState } from "../../lib/routines/routine-draft";
import { RoutineEditor } from "./RoutineEditor";

// The test alias for the macro package has no Trans, so it renders its children as the web build does.
vi.mock("@lingui/react/macro", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lingui/react/macro")>()),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./routine-editor/model-settings", () => ({ RoutineModelSettings: () => null }));
vi.mock("./RoutineRunHistory", () => ({ RoutineRunHistory: () => null }));
vi.mock("../../lib/query/rpc", () => {
  const rpc = new Proxy({}, { get: () => new Proxy({}, { get: () => vi.fn(async () => null) }) });
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});

const routine = {
  id: "routine-1",
  botId: "bot-1",
  name: "Daily",
  prompt: "Summarize",
  crons: ["0 9 * * *"],
  timezone: "UTC",
  active: true,
  notify: true,
  inChat: false,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  emailSenders: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  watch: null,
  watchState: null,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  editable: true,
} as unknown as Routine;

const onBack = vi.fn();
const onClose = vi.fn();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let latestDraft: RoutineDraftState;

function Harness({ editing }: { editing: Routine | null }) {
  const [draft, setDraft] = useState(
    editing ? draftStateFromRoutine(editing) : emptyRoutineDraftState(),
  );
  latestDraft = draft;
  const noop = vi.fn();
  return (
    <RoutineEditor
      bot={{ id: "bot-1", name: "Bot" }}
      draft={draft}
      onChange={setDraft}
      editing={editing}
      timezone="UTC"
      webhook={{ path: "/hook", secret: null, configured: false }}
      githubPath="/github"
      messageProviders={[]}
      saving={false}
      running={false}
      error={null}
      onBack={onBack}
      onClose={onClose}
      onSave={noop}
      onSetActive={noop}
      onCopy={noop}
      onTestRun={noop}
      onDelete={noop}
      onEnsureWebhook={async () => {}}
      onRevealWebhook={async () => {}}
      onHideWebhook={noop}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host, new QueryClient({ defaultOptions: { queries: { retry: false } } }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function render(editing: Routine | null) {
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <Harness editing={editing} />
      </I18nProvider>,
    ),
  );
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent === label,
  ) as HTMLButtonElement;

async function typeName(value: string) {
  const input = host.querySelector("input[type=text], input:not([type])") as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("asks before closing a draft with typed work and keeps it on Cancel", async () => {
  await render(null);
  await typeName("Morning digest");
  await act(async () => button("Close").click());
  expect(onClose).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Discard unsaved changes?");

  await act(async () => button("Cancel").click());
  expect(onClose).not.toHaveBeenCalled();
  expect(latestDraft.name).toBe("Morning digest");
});

it("goes back after Discard is confirmed", async () => {
  await render(null);
  await typeName("Morning digest");
  await act(async () => button("Back").click());
  expect(onBack).not.toHaveBeenCalled();
  await act(async () => button("Discard").click());
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
});

it("closes at once when nothing was changed", async () => {
  await render(null);
  await act(async () => button("Close").click());
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain("Discard unsaved changes?");
});

it("treats edits to a saved routine as unsaved until they match it again", async () => {
  await render(routine);
  await act(async () => button("Back").click());
  expect(onBack).toHaveBeenCalledTimes(1);

  await typeName("Weekly");
  await act(async () => button("Close").click());
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => button("Cancel").click());

  await typeName("Daily");
  await act(async () => button("Close").click());
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("counts an edited run time of a one-time routine as unsaved", async () => {
  const oneShot = {
    ...routine,
    crons: [ONCE_ROUTINE_CRON],
    nextRunAt: null,
    lastRunAt: null,
  } as Routine;
  await render(oneShot);
  expect(latestDraft.runAtLocal).not.toBe("");
  await act(async () => button("Back").click());
  expect(onBack).toHaveBeenCalledTimes(1);

  const input = host.querySelector("input[type=datetime-local]") as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "2031-05-06T07:08");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Close").click());
  expect(onClose).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Discard unsaved changes?");
});

it("keeps a run time edited while saving a one-time routine as unsaved", async () => {
  const oneShot = { ...routine, crons: [ONCE_ROUTINE_CRON] } as Routine;
  await render(oneShot);
  const input = host.querySelector("input[type=datetime-local]") as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "2031-05-06T07:08");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // The save finishes and arms the routine, keeping the edit made while it was in flight.
  await render({ ...oneShot, nextRunAt: "2031-01-01T00:00:00.000Z" } as Routine);
  await act(async () => button("Close").click());
  expect(onClose).not.toHaveBeenCalled();
});

it("offers an end date only on a repeating routine and removes it with its button", async () => {
  await render({ ...routine, endsAt: "2031-11-30T23:59:59.999Z" } as Routine);
  const input = host.querySelector("input[type=date]") as HTMLInputElement;
  expect(input.value).toBe("2031-11-30");
  await act(async () => button("Remove end date").click());
  expect(latestDraft.endsOn).toBe("");

  await act(async () => root.unmount());
  root = createRoot(host, new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  await render({ ...routine, crons: [ONCE_ROUTINE_CRON] } as Routine);
  expect(host.querySelector("input[type=date]")).toBeNull();
});

it("offers no end date on a routine a webhook starts", async () => {
  await render({ ...routine, webhookEnabled: true } as Routine);
  expect(host.querySelector("input[type=date]")).toBeNull();
});
