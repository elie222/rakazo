import { randomUUID } from "node:crypto";
import type { PageAbility } from "@rakazo/contracts";
import {
  abortableDelay,
  deadlineSignal,
  pageCopyResult,
  pageViewerDocument,
  withSandboxedArtifactCsp,
} from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { desktopLocale, t } from "../../i18n.js";
import type { PageAppApi, PageAppViewWithAbilities } from "../page-app-api.js";
import { PageAppRequestError } from "../page-app-api.js";
import type { FrameRequest } from "./frame-requests.js";
import { askAnswer, createRateLimit, frameRequest } from "./frame-requests.js";
import type { PageAppScreen } from "./page-app-shell.js";
import { FRAME_ORIGIN } from "./page-app-shell.js";

const NOTIFY_INTERVAL_MS = 10_000;
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
  viewed: (view: PageAppViewWithAbilities) => void;
};

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
  let view: PageAppViewWithAbilities | null = null;
  let runtime: string | null = null;
  let shown: string | null = null;
  let frame = { id: 0, document: "" };
  let screen: PageAppScreen | null = null;
  let reading: Promise<void> | null = null;
  let again: { force: boolean } | null = null;
  let asks = 0;
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
  async function consent(next: PageAppViewWithAbilities) {
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

  async function imageSources(page: PageAppViewWithAbilities["page"]) {
    const entries = await Promise.all(
      Object.entries(page.images).map(async ([name, imageId]) => {
        const cached = images.get(imageId) ?? (await api.image(imageId));
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
    if (!force && key === shown) return;
    if (force || runtime === null) runtime = await api.runtime();
    const document = pageViewerDocument({
      runtime,
      code: next.page.code,
      images: await imageSources(next.page),
      theme: host.theme(),
      errorTitle: t("Page failed to load."),
      surface: host.surface(),
      lang: desktopLocale(),
      state: next.page.readerState ?? {},
    });
    // Hosts that can ask mark the document, as the kit's `askBot` checks before it asks.
    frame = {
      id: frame.id + 1,
      document: withSandboxedArtifactCsp(
        ask ? document.replace("<html", "<html data-ask") : document,
      ),
    };
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
        for await (const _ of api.changes(stopped.signal)) {
          delay = 1_000;
          refresh();
        }
      } catch (error) {
        if (isRemoved(error)) return fail(error);
      }
      if (stopped.signal.aborted) return;
      await abortableDelay(delay, stopped.signal);
      delay = Math.min(delay * 2, CHANGES_RETRY_MAX_MS);
      // A signal may have been missed while the stream was down.
      refresh();
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
        await api.saveState(request.values).catch(fail);
        return null;
      case "open-link":
        host.openLink(request.url);
        return null;
      case "copy":
        return pageCopyResult(request.id, host.copy(request.text));
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
    message: async (data: unknown) => {
      const request = frameRequest(data);
      return request ? answer(request) : null;
    },
    view: () => view,
  };
}
