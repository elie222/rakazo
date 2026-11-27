import { randomUUID } from "node:crypto";
import type { PageAbility, PageAppView, PageState } from "@rakazo/contracts";
import {
  abortableDelay,
  deadlineSignal,
  pageCopyResult,
  pageViewerDocument,
  withSandboxedArtifactCsp,
} from "@rakazo/core";
import { bestEffort, getLogger } from "@rakazo/logging";
import { desktopLocale, t } from "../../i18n.js";
import type { PageAppApi } from "../page-app-api.js";
import { PageAppRequestError } from "../page-app-api.js";
import type { FrameRequest } from "./frame-requests.js";
import { askAnswer, createRateLimit, frameRequest } from "./frame-requests.js";
import type { PageAppScreen } from "./page-app-shell.js";
import { FRAME_ORIGIN } from "./page-app-shell.js";

const NOTIFY_INTERVAL_MS = 10_000;
/** Nothing stops a page from asking in a loop, as a browser's popup blocker would. */
const LINK_INTERVAL_MS = 2_000;
const COPY_INTERVAL_MS = 1_000;
const ASK_DEADLINE_MS = 10 * 60_000;
const MAX_ASKS = 3;
const CHANGES_RETRY_MAX_MS = 60_000;

/** What the controller needs from the window and the system; Electron supplies it. */
export type PageAppHost = {
  name: string;
  theme: () => "light" | "dark";
  surface: () => string;
  show: (screen: PageAppScreen) => void;
  /** Asks the person in a native dialog; true when they allow it. */
  confirmAbility: (ability: PageAbility) => Promise<boolean>;
  notify: (title: string, body: string) => void;
  openLink: (url: string) => void;
  copy: (text: string) => boolean;
  /** The token no longer works: the app was removed. */
  removed: () => void;
  /** The view changed, so menus that depend on it can update. */
  viewed: (view: PageAppView) => void;
};

/** JSON with object keys sorted, since the database keeps its own key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** A refusal resending cannot change, such as values past the page's limits. */
function refusedForGood(error: unknown) {
  return (
    error instanceof PageAppRequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401 &&
    error.status !== 429
  );
}

function isRemoved(error: unknown) {
  return error instanceof PageAppRequestError && error.status === 401;
}

/**
 * The installed app's page: reads it with the app's token, shows it in the sandboxed frame,
 * answers what the frame asks for, and follows changes.
 */
export function createPageAppController(api: PageAppApi, host: PageAppHost) {
  const stopped = new AbortController();
  const images = new Map<string, string>();
  const declined = new Set<string>();
  const mayNotify = createRateLimit(NOTIFY_INTERVAL_MS);
  const mayOpenLink = createRateLimit(LINK_INTERVAL_MS);
  const mayCopy = createRateLimit(COPY_INTERVAL_MS);
  let view: PageAppView | null = null;
  let runtime: string | null = null;
  let shown: string | null = null;
  let frame = { id: 0, document: "" };
  let screen: PageAppScreen | null = null;
  let reading: Promise<void> | null = null;
  let again: { force: boolean } | null = null;
  let asks = 0;
  let unsaved: PageState = {};
  /** The reader's values as the shown frame has them: what it opened with and saved since. */
  let known: PageState = {};
  let saving: Promise<void> | null = null;
  let consenting = false;

  function show(next: PageAppScreen) {
    screen = next;
    host.show(next);
  }

  function fail(error: unknown) {
    if (stopped.signal.aborted) return;
    if (isRemoved(error)) {
      stopped.abort();
      host.removed();
    } else if (view === null || (error instanceof PageAppRequestError && error.status === 404)) {
      show({ message: t("Page failed to load."), lang: desktopLocale() });
    }
  }

  const approved = (ability: PageAbility) => view?.approved.includes(ability) === true;

  /**
   * Asks, one dialog at a time, for each ability this version uses that the person has not
   * approved or declined, while the page already shows; an approval shows it again with it.
   */
  async function consent(next: PageAppView) {
    if (consenting) return;
    consenting = true;
    try {
      let approvals = next.approved;
      for (const ability of next.page.abilities) {
        const key = `${next.page.version}:${ability}`;
        if (approvals.includes(ability) || declined.has(key)) continue;
        if (!(await host.confirmAbility(ability))) {
          declined.add(key);
          continue;
        }
        approvals = await api.approve([...approvals, ability]);
        refresh();
      }
    } finally {
      consenting = false;
    }
  }

  async function imageSources(page: PageAppView["page"]) {
    const entries = await Promise.all(
      Object.entries(page.images).map(async ([name, imageId]) => {
        const cached = images.get(imageId) ?? (await api.image(imageId, page.version));
        images.set(imageId, cached);
        return [name, cached] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  async function read(force: boolean) {
    const next = await api.view(stopped.signal);
    view = next;
    void consent(next).catch(fail);
    host.viewed(next);
    const ask = next.page.abilities.includes("ask") && next.approved.includes("ask");
    const key = JSON.stringify([next.page.version, ask, host.theme(), desktopLocale()]);
    // Values changed on another device draw the page again; the frame's own saves do not.
    const stateChanged = canonical(next.page.readerState ?? {}) !== canonical(known);
    const pending = saving !== null || Object.keys(unsaved).length > 0;
    if (!force && key === shown && (!stateChanged || pending)) return;
    if (force || runtime === null) runtime = await api.runtime();
    const document = pageViewerDocument({
      runtime,
      code: next.page.code,
      images: await imageSources(next.page),
      theme: host.theme(),
      errorTitle: t("Page failed to load."),
      surface: host.surface(),
      lang: desktopLocale(),
      // Values not saved yet are the reader's latest, over the server's older copy.
      state: { ...next.page.readerState, ...unsaved },
      ask,
    });
    frame = { id: frame.id + 1, document: withSandboxedArtifactCsp(document) };
    known = { ...next.page.readerState, ...unsaved };
    shown = key;
    show({ frame: `${FRAME_ORIGIN}/${frame.id}`, title: host.name, lang: desktopLocale() });
  }

  /** Reads the page again; a request while one runs reads once more after it. */
  function refresh(force = false) {
    if (stopped.signal.aborted) return;
    if (reading) {
      again = { force: force || again?.force === true };
      return;
    }
    if (Object.keys(unsaved).length) void saveState({});
    reading = read(force)
      .catch(fail)
      .finally(() => {
        reading = null;
        const next = again;
        again = null;
        if (next) refresh(next.force);
      });
  }

  async function followChanges() {
    let delay = 1_000;
    while (!stopped.signal.aborted) {
      try {
        let opened = false;
        for await (const _ of api.changes(stopped.signal)) {
          // Every stream opens with a signal, so only a later one shows the stream holds.
          if (opened) delay = 1_000;
          opened = true;
          refresh();
        }
      } catch (error) {
        if (isRemoved(error)) return fail(error);
        getLogger().warn("page app change stream ended", { error });
      }
      if (stopped.signal.aborted) return;
      await abortableDelay(delay, stopped.signal);
      delay = Math.min(delay * 2, CHANGES_RETRY_MAX_MS);
      // A signal may have been missed while the stream was down.
      refresh();
    }
  }

  /**
   * Saves go one at a time, in order, so an older one never lands last. Values a save could not
   * reach the server with go again with the next; values the server refused are dropped.
   */
  function saveState(values: PageState) {
    unsaved = { ...unsaved, ...values };
    known = { ...known, ...values };
    saving ??= flushState().finally(() => {
      saving = null;
    });
    return saving;
  }

  async function flushState() {
    while (Object.keys(unsaved).length) {
      const sending = unsaved;
      unsaved = {};
      try {
        await api.saveState(sending);
      } catch (error) {
        fail(error);
        if (!refusedForGood(error)) {
          unsaved = { ...sending, ...unsaved };
          return;
        }
      }
    }
  }

  async function ask(id: string, text: string) {
    if (!approved("ask") || asks >= MAX_ASKS) return askAnswer(id, null);
    asks += 1;
    try {
      const signal = deadlineSignal(ASK_DEADLINE_MS, stopped.signal);
      for await (const event of api.ask(text, randomUUID(), signal)) {
        if (event.kind === "answer") return askAnswer(id, event.text);
        if (event.kind === "failed") break;
      }
      return askAnswer(id, null);
    } catch (error) {
      fail(error);
      return askAnswer(id, null);
    } finally {
      asks -= 1;
    }
  }

  async function answer(request: FrameRequest): Promise<unknown> {
    switch (request.kind) {
      case "state":
        await saveState(request.values);
        return null;
      case "open-link":
        if (mayOpenLink()) host.openLink(request.url);
        return null;
      case "copy":
        return pageCopyResult(request.id, mayCopy() && host.copy(request.text));
      case "ask":
        return ask(request.id, request.text);
      case "notify":
        if (approved("notify") && mayNotify()) host.notify(request.title, request.body);
        return null;
    }
  }

  return {
    start() {
      refresh();
      void bestEffort("follow page changes", followChanges());
    },
    stop: () => stopped.abort(),
    refresh,
    screen: () => screen,
    /** The frame's document while it is the one shown; older frames get nothing. */
    frameDocument: (id: number) => (id === frame.id ? frame.document : null),
    message: async (data: unknown, from: unknown) => {
      if (from !== `${FRAME_ORIGIN}/${frame.id}`) return null;
      const request = frameRequest(data);
      return request ? answer(request) : null;
    },
    view: () => view,
  };
}
